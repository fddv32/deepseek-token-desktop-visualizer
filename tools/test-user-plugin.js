// 验证「用户级插件」这条路整条都是通的，而不是只有文档上写着通：
//   1) ~/.whalepet/providers/*.js 能被装载，并且 builtin=false、userLevel=true（设置里才有「删除文件」）
//   2) 能读到自己写的账本，算对「今日合计」（跨天的记录必须被排除）
//   3) 能按 meta.damage 阈值发事件，且**首轮不发**（否则启动就放一串受击动画）
//   4) 卸载 → 字段被摘掉；重新安装 → 字段回到可添加列表；删除文件 → 文件真没了
//
// 跑完会把账本恢复成原样、把临时插件删掉，不会在你机器上留示例数据。
//
// **整套东西跑在沙箱里**（WHALEPET_HOME 指到临时目录），不碰用户的真实文件。
// 为什么不"改完再还原"：桌宠**可能正在运行**，它一 poll 就把这些测试账目当成真实消费
// 记进 `usage-history.json`；用量账本是按天累加的，事后还原账本也擦不掉。实测就踩过：
// 用户的用量面板里凭空多出「1.8 万 token · ¥1.25 · 2 次」，而他一路只用了积分。
//
// 锁还是留着：脚本会往 usage.json（在仓库目录里、不在沙箱内）写配置，两次同时跑会打架。
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// 沙箱。必须在 require ../usage 之前设好 —— api.js 在 require 时就把 PLUGIN_HOME 定下来了。
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'whalepet-test-'))
process.env.WHALEPET_HOME = SANDBOX

const LEDGER = path.join(SANDBOX, '.whalepet', 'ledger.jsonl')
const PLUGIN_DIR = path.join(SANDBOX, '.whalepet', 'providers')
// 锁放在**系统临时目录**、不放沙箱里：沙箱是每次跑都新建的，各跑各的锁等于没有锁。
const LOCK = path.join(os.tmpdir(), 'whalepet-ledger-test.lock')
const TMP_ID = 'zz-tmp-remove-test'
const TMP_FILE = path.join(PLUGIN_DIR, TMP_ID + '.js')

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err && err.code === 'EPERM' }
}

/** 抢到返回 fd，抢不到返回 null。 */
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true })
  // 两轮：第一轮失败时如果发现持有者已经死了（上次被 Ctrl-C 打断留下的锁文件），
  // 就清掉再抢一次 —— 别让「上次没跑完」变成「这次永远跑不了」。
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = fs.openSync(LOCK, 'wx') // wx：文件已存在就抛 EEXIST
      fs.writeSync(fd, String(process.pid))
      return fd
    } catch {
      let holder = 0
      try { holder = Number(fs.readFileSync(LOCK, 'utf8')) || 0 } catch { /* 读不到就当未知 */ }
      if (holder > 0 && holder !== process.pid && !pidAlive(holder)) {
        try { fs.rmSync(LOCK, { force: true }) } catch { /* 忽略 */ }
        continue
      }
      return null
    }
  }
  return null
}

const lockFd = acquireLock()
if (lockFd === null) {
  console.log('!! 已经有另一个实例在跑（' + LOCK + '）。')
  console.log('   这个脚本会临时改写账本，必须串行执行。等它跑完再试，或手工删掉上面那个文件。')
  process.exit(2)
}

const pad = (s, n) => String(s).padEnd(n)
let pass = 0
let fail = 0
function check(ok, label, extra) {
  if (ok) { pass += 1; console.log('  \u2713 ' + label) }
  else { fail += 1; console.log('  \u2717 ' + label + (extra ? '  -> ' + extra : '')) }
}

/* 两条北京时间「今天」的记录 + 一条「昨天」的。昨天那条绝不能被算进来。
 *
 * 时间戳锚在**当天的固定时刻**，不要用「40 分钟前」这类相对偏移 ——
 * 那样在午夜刚过时跑测试，「40 分钟前」就已经掉到昨天去了，
 * 「今日金额 = ¥1.25」这几条断言必然失败（实测在 00:0x 踩到过，还很迷惑：
 * 代码什么都没改，白天跑全绿、夜里跑红）。 */
const BJ = 8 * 60 * 60 * 1000
function iso(ms) {
  return new Date(ms + BJ).toISOString().replace('Z', '+08:00')
}
const now = Date.now()
const noon = new Date(now)
noon.setHours(12, 0, 0, 0)
const tToday1 = noon.getTime() - 60 * 60 * 1000           // 今天 11:00
const tToday2 = noon.getTime()                            // 今天 12:00
const tYesterday = noon.getTime() - 24 * 60 * 60 * 1000   // 昨天 12:00

let restoreDone = false
function restore() {
  if (restoreDone) return
  restoreDone = true
  try {
    // 账本和临时插件都在沙箱里，整个目录删掉就行 —— 不需要"备份再写回"。
    // 那套写回是有毒的：上一次被 Ctrl-C 留下的测试账本，下一次会被当成"用户的原样"再写回去。
    fs.rmSync(SANDBOX, { recursive: true, force: true })
    // 配置必须还原。**这个必须做**：下面会故意卸载 workbuddy 来验「内置插件也能卸载」，
    // 而卸载会把它的字段（ctx / workbuddy）从显示列表里摘掉 —— 不还原的话，
    // 跑一次测试就把用户的信息条配置改小了，而且不会有任何提示。
    // （usage.json 在仓库目录里、不在沙箱内，所以这一项还是得手工还原。）
    for (const [id, on] of Object.entries(originalInstalled)) usage.installProvider(id, on)
    usage.setFields(originalFields)
  } catch (err) {
    console.log('!! 恢复现场失败：' + err.message)
  }
  // 放锁。放在最后：前面任何一步抛错都不该让锁泄出去。
  try { fs.closeSync(lockFd) } catch { /* 忽略 */ }
  try { fs.rmSync(LOCK, { force: true }) } catch { /* 忽略 */ }
}
process.on('exit', restore)

fs.mkdirSync(PLUGIN_DIR, { recursive: true })
// 把**用户真实的插件**只读拷进沙箱：测试要验的就是「用户级插件这条路是通的」，
// 沙箱里没有插件就什么都验不了。拷进来之后，真文件一个字都不会被碰。
const REAL_USER_DIR = path.join(os.homedir(), '.whalepet', 'providers')
let seeded = []
if (fs.existsSync(REAL_USER_DIR)) {
  for (const name of fs.readdirSync(REAL_USER_DIR)) {
    if (!name.endsWith('.js') || name.startsWith('zz-tmp-')) continue  // 跳过历史遗留的测试插件
    fs.copyFileSync(path.join(REAL_USER_DIR, name), path.join(PLUGIN_DIR, name))
    seeded.push(name)
  }
}
console.log('沙箱 ' + SANDBOX)
console.log('  拷进用户插件 ' + (seeded.length ? seeded.join(', ') : '（无）'))
fs.writeFileSync(LEDGER, [
  '# 临时账本（测试用，跑完会恢复）',
  '# 昨天那条应当被排除在「今日」之外',
  JSON.stringify({ at: iso(tYesterday), service: '昨天不该出现', cost: 99 }),
  JSON.stringify({ at: iso(tToday1), service: 'ChatGPT 网页版', cost: 1.25 }),
  JSON.stringify({ at: iso(tToday2), service: 'Gemini 网页版', tokens: 18000 }),
  '',
].join('\n'), 'utf8')

const usage = require('../usage')

// 进来时的原始配置，跑完由 restore() 还原（见上面那段注释）。
//
// 但 `TMP_ID` 自己的痕迹**不能**算进"原始配置"：上一次跑测试被 Ctrl-C / 被杀掉时，
// 它留下的插件文件和 installed 标记会被这一次当成"原本就有"，然后再原样写回去 ——
// 于是这个临时插件就永远留在用户的配置里了（实测就是这样留了十几个小时，
// 表现是面板的「字段」页多出一个「临时 zz-tmp-remove-test-f」）。
// 所以这个名字一律当作自己的东西丢掉，不管它进没进来。
const originalFields = usage.publicConfig().fields.filter(f => f !== TMP_ID + '-f')
const originalInstalled = { ...usage.publicConfig().installed }
delete originalInstalled[TMP_ID]

console.log('一、装载与身份')
let list = usage.listProviders()
const manual = list.providers.find(p => p.id === 'manual')
check(!!manual, '手动记账插件被装载', manual ? '' : '没找到 id=manual')
if (manual) {
  check(manual.builtin === false, 'builtin=false（面板会给删除按钮）')
  check(manual.userLevel === true, 'userLevel=true')
  check(manual.loaded === true, 'create() 实例化成功')
  check((manual.fields || []).length === 1, '声明了 1 个可选字段')
  console.log('      vendor=' + manual.vendor + '  读取=' + (manual.paths || []).join(','))
}

console.log('')
console.log('二、读账本（昨天那条必须被排除）')
let r = usage.poll(now)
check(r.events.length === 0, '首轮不发事件（armed 生效）', '实际 ' + r.events.length + ' 条')
const afterPoll = usage.listProviders().providers.find(p => p.id === 'manual') || {}
check(afterPoll.available === true, '账本文件存在 -> available=true')
console.log('      面板上那行会显示：' + afterPoll.detail)
const raw = r.snapshot.providers.manual || {}
check(Math.abs(raw.todayCost - 1.25) < 1e-9, '今日金额 = ¥1.25（不含昨天的 ¥99）', '实际 ' + raw.todayCost)
check(raw.callsToday === 2, '今日 2 次', '实际 ' + raw.callsToday)
check(raw.todayTokens === 18000, '今日 token = 18000（纯 token 那条也算进来）', '实际 ' + raw.todayTokens)
check(!(raw.services || []).includes('昨天不该出现'), '昨天的服务名没进明细', JSON.stringify(raw.services))
console.log('      信息条字段：' + r.snapshot.fields.map(f => (f.label ? f.label + '=' + f.value : f.value)).join('  |  '))

console.log('')
console.log('三、追加一笔 -> 应当且只应当发一条事件，档位按阈值')
fs.appendFileSync(LEDGER, JSON.stringify({ at: iso(Date.now()), service: 'ChatGPT 网页版', cost: 0.4 }) + '\n', 'utf8')
r = usage.poll(Date.now())
check(r.events.length === 1, '新增 1 行 -> 1 条事件', '实际 ' + r.events.length + ' 条')
if (r.events.length) {
  const ev = r.events[0]
  console.log('      ' + JSON.stringify(ev))
  check(ev.source === 'manual', 'source=manual')
  check(ev.level === 'normal', '¥0.4 >= 0.3 -> normal（档位，不是动作名）', '实际 ' + ev.level)
}
r = usage.poll(Date.now() + 1000)
check(r.events.length === 0, '没有新增行时不重复发事件', '实际 ' + r.events.length + ' 条')

console.log('')
console.log('四、卸载 / 安装 / 删除文件')
fs.writeFileSync(TMP_FILE, [
  "'use strict'",
  'module.exports = {',
  "  meta: { id: '" + TMP_ID + "', label: '临时插件', fields: [{ id: '" + TMP_ID + "-f', label: '临时' }] },",
  '  create: () => ({ available: false, detail: \'\', poll() {}, fields: () => [] }),',
  '}',
  '',
].join('\n'), 'utf8')
usage.reload()
list = usage.listProviders()
const tmp = list.providers.find(p => p.id === TMP_ID)
check(!!tmp && tmp.builtin === false, '临时用户插件被装载且不是内置')

// 卸载：它声明的字段应当从显示列表里被摘掉
const before = usage.publicConfig().fields.slice()
usage.setFields(before.concat(TMP_ID + '-f'))
check(usage.publicConfig().fields.includes(TMP_ID + '-f'), '临时字段已加进显示列表')
usage.installProvider(TMP_ID, false)
check(!usage.publicConfig().fields.includes(TMP_ID + '-f'), '卸载后字段被摘掉')
check(usage.listProviders().providers.find(p => p.id === TMP_ID).installed === false, 'installed=false')
// 重新安装只让它回到「可添加字段」里，**不会**自作主张塞回显示列表 ——
// 否则卸载一个插件再装回来，信息条顺序会被悄悄改掉。
usage.installProvider(TMP_ID, true)
check(usage.listProviders().providers.find(p => p.id === TMP_ID).installed === true, 'installed 恢复 true')
check(usage.fieldCatalog().some(f => f.id === TMP_ID + '-f'), '重新安装后字段回到可添加列表')
usage.setFields(before)

// 内置插件：可以卸载，但拒绝删文件
usage.installProvider('workbuddy', false)
check(usage.listProviders().providers.find(p => p.id === 'workbuddy').installed === false, '内置插件也能卸载')
usage.installProvider('workbuddy', true)
const res2 = usage.deleteProvider('workbuddy')
check(res2.ok === false && /内置/.test(res2.message), '内置插件拒绝删除文件', JSON.stringify(res2))

const res = usage.deleteProvider(TMP_ID)
check(res.ok === true, '删除用户插件返回 ok', JSON.stringify(res))
check(!fs.existsSync(TMP_FILE), '插件文件真的被删掉了')

restore()
console.log('')
console.log('现场已恢复：' + LEDGER + '、usage.json 的字段与安装状态')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exitCode = fail ? 1 : 0
