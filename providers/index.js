// providers/index.js —— 用量插件加载器
//
// 两类插件目录：
//   内置：<应用目录>/providers/*.js        —— 随应用分发，只能停用、不能删
//   用户：~/.whalepet/providers/*.js       —— 用户自己放的，可以在设置面板里删掉
//
// 插件的约定（见 providers/README.md）：
//   module.exports = { meta: {...}, create(api) -> 实例 }
//
// 加载策略：任何单个插件出问题都只影响它自己。语法错、meta 缺字段、create 抛异常
// 都会被捕获并记进 errors，其余插件照常工作 —— 桌宠不能因为一个第三方插件变砖。
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const api = require('./api')

const BUILTIN_DIR = __dirname
const USER_DIR = path.join(os.homedir(), '.whalepet', 'providers')
// index.js / api.js 是宿主自己的模块；下划线开头的（_template.js 等）是模板或草稿，
// 都不该被当成插件加载。想临时搁置一个插件，把它改名成 _xxx.js 就行。
const SKIP = new Set(['index.js', 'api.js'])

function isPluginFile(name) {
  const lower = name.toLowerCase()
  return lower.endsWith('.js') && !name.startsWith('_') && !SKIP.has(name)
}

const META_FIELDS = ['id', 'label']
const errors = []

function loadDir(dir, builtin) {
  const out = []
  let names = []
  try {
    names = fs.readdirSync(dir).filter(isPluginFile)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    const file = path.join(dir, name)
    let mod
    try {
      // 每次 require 前清缓存：设置面板里的「重载插件」要能拿到新代码
      delete require.cache[require.resolve(file)]
      mod = require(file)
    } catch (err) {
      errors.push({ file, message: '加载失败：' + String((err && err.message) || err) })
      continue
    }
    const meta = mod && mod.meta
    if (!meta || typeof meta !== 'object') {
      errors.push({ file, message: '缺少 module.exports.meta' })
      continue
    }
    const missing = META_FIELDS.filter(k => !meta[k])
    if (missing.length) {
      errors.push({ file, message: 'meta 缺字段：' + missing.join(', ') })
      continue
    }
    if (typeof mod.create !== 'function') {
      errors.push({ file, message: '缺少 module.exports.create(api)' })
      continue
    }
    out.push({
      meta: {
        builtin: builtin === true,
        badge: '·',
        vendor: '',
        desc: '',
        paths: [],
        fields: [],
        // 这个来源的「用量」用什么单位：'credit'（积分）/ 'token' / 'CNY'。
        // 信息条据此给数字加小字后缀，也决定它算进「今日已用」的哪一栏。
        unit: 'token',
        ...meta,
        builtin: builtin === true, // 不允许插件自称内置
      },
      create: mod.create,
      file,
      userLevel: !builtin,
    })
  }
  return out
}

/** 全部可用插件定义（未实例化）。同一 id 时用户插件覆盖内置插件。 */
function list() {
  errors.length = 0
  const merged = new Map()
  for (const p of loadDir(BUILTIN_DIR, true)) merged.set(p.meta.id, p)
  for (const p of loadDir(USER_DIR, false)) merged.set(p.meta.id, p)
  return { providers: [...merged.values()], errors: errors.slice() }
}

/** 实例化一个插件。create 里抛错就返回 null，并且不让异常冒到调用方。 */
function instantiate(def) {
  try {
    const inst = def.create(api)
    if (!inst || typeof inst.poll !== 'function' || typeof inst.fields !== 'function') {
      errors.push({ file: def.file, message: 'create() 返回值不满足接口（需要 poll / fields）' })
      return null
    }
    return inst
  } catch (err) {
    errors.push({ file: def.file, message: 'create() 抛错：' + String((err && err.message) || err) })
    return null
  }
}

module.exports = {
  list,
  loadDir,
  instantiate,
  api,
  USER_DIR,
  BUILTIN_DIR,
  errors,
}
