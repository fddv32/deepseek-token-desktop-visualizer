# -*- coding: utf-8 -*-
"""从四张透明素材合成傻鱼的整套动作帧。

素材（都由 make-shayu-sticker.py 产出）：
  _sticker-hips.png   双手叉腰 · **全身站姿，结构最完整** —— 所有动作的**主体模板**
  _sticker-open.png   双眼睁开 · 剪刀手（半身）—— 只用来提供眼部像素
  _sticker-shut.png   双眼闭合（半身）—— 用来提供「闭眼」那块像素
  _sticker.png        眯眼 · 剪刀手（原画，**另一套构图，不参与合成**，见 ⑥）

## 七个关键设计

**① 主体统一用 hips 那张半身。**
另外三张是「半身构图」：源图里裙摆画到画面下边界就被切了。而 hips 是完整站姿：裙子有
完整蕾丝下摆、有尾巴。所以把它当模板，四个姿势的结构就天然一致了。

**② 「半身」= 抹掉腿，不是裁到裙摆。**
hips 剪影里最低的那条是**腿**（x 244..424、y≥802），半身像不要腿。但**尾巴**（x>430）
一直垂到 y≈824 —— 按矩形裁到裙摆下沿（800）会把尾鳍切掉一截。所以用掩码：只把腿那
一片抹透明，其余全留。这样裙子收在完整的蕾丝波浪上，尾巴也完整。

抹腿**不是一条直线**：蕾丝下沿是波浪形的 —— 波谷处大腿根会从蕾丝缝里露出来（用户报的
「裙子下面还能看到一点腿」），而波峰处蕾丝本身就低到直线以下，整条抬上去又会把蕾丝啃掉
一口。现在逐列切，判据是「大腿根的暖粉」（见 drop_legs()）：蕾丝褶皱够不到那个暖度、
裙子上的金色星星被第二个条件挡住。实测 56 列被抬高、切线在 792~802 之间波动。

**③ 表情逐只眼搬，锚点用瞳孔自动定标。**
两张脸的**眼距不一样**（open 141px、hips 133px），所以必须逐只眼搬。但锚点**不能目测**：
早先手标的中心差十几像素，表现就是「闭眼顶到刘海 + 下面残留一道睁眼睫毛（黑线）」，
而手写的缩放 1.02 方向还是反的（实际要缩小）。现在用瞳孔定标 —— 瞳孔是虹膜正中、
全图最暗、形状最稳的特征，左右各找一个，两点就定死位移和缩放（见 calibrate_eyes()）。

**④ 眨眼不做「交叉混合」，也不做「眼皮下落」。**
`open*0.45 + shut*0.55` 会把睁眼的虹膜和闭眼的睫毛线**叠成重影**；「眼皮下落」又因为
闭眼的睫毛线本来就画在眼睛偏下、压不到一半。所以只留 **睁 → 闭 → 睁** 三段硬切。

**⑤ 抹掉抠图漏下来的「封闭白块」。**
抠图只从画布四边洪泛判背景，**被角色轮廓包住的背景**（尾巴根部那块、头发缝里几块）
进不去，就留成了不透明近白 —— 桌面上是「尾巴上方一块白」，压深色壁纸特别突兀。
这里在公共空间里按「近白 + 不透明 + 成块 + 不在保留区」抹掉（见 HOLE_KEEP）。

**⑦ 整张脸重画成「只有头发 + 眼睛 + 一对眉毛 + 嘴巴」。**
用户反复报的脸上异物（额头亮点、眉心竖线、脸颊细道、腮红杂点、被搬运错位的眉毛）
本质是同一类问题：五官之外还有别的东西画在脸上。逐个点位去补补不完，改成整张脸
统一处理（clean_face）—— 以两眼瞳孔为心画椭圆脸区，脸里只认四样东西，其余平涂成
同一片皮肤。三个容易踩的坑写在 clean_face() 的注释里：肤色基线要**只测一次**
（逐帧各测会漂，眨眼时脸会暗一档）、眉毛要按**局部相对暗度**认（按绝对色筛，
1478 个候选只落中 16px，眉毛会被自己抹平）、脸里的**近白色一律平涂**（闭眼帧的
眼窝填充会从眼白插值出一片死白）。

**⑥ happy 的滞空帧：一格 wink 像素都不用。**
「蹦起来左手比耶」在叉腰那张上做不出来（手在腰上），所以早先这一帧整张搬
`_sticker.png`（原画就是剪刀手 + 单眼眨）。它是**另一套构图**，这一搬就把两个毛病
一起带上桌面了：

1. `build_expression()` 圈眼区用的是 `eye_weight()`（两张图的差异）。两张**不同的画**
   在头发走向、荷叶边弧形、蕾丝细节上处处不同，差异图会整片饱和 —— 实测
   `eye_weight(open, wink)` 映到 hips 后 `m>0.10` 覆盖了 **53.5% 的身体**。于是
   `rgb = hips*(1-m) + wink*m` 把 wink 那张**在 hips 的剪影里又铺了一遍**：脸上是
   两张脸叠着（「脸部扭曲」），wink 自己的描边、荷叶边落在 hips 轮廓里侧，成了
   一圈对不上的线（「跳跃时背后有残影」）。
2. `clean_face()` 当时是「谁采到 300 个采样点谁就就地改肤色基准」，这个混合结果把
   基准从 `[250,228,219]` 改成了 `[245,203,190]`（混进了 wink 的腮红）——
   基准是全局的，于是**之后每一张脸**都跟着偏红。

后来改成「只把 wink 的比耶左臂嫁接过来」，也不行：那个窗口里 **88% 的像素不是手**
（wink 的头发、荷叶边、袖口一起搬了过来），手周围照样是一圈对不上的描边。
所以这一版**一格 wink 像素都不用**：眨的那只眼是从 `_sticker-shut.png` 算出来的
闭眼（blink 用的同一套 `build_closed_eyes()`，加 `half="R"` 只闭角色左眼）——
身体和脸与其它 57 帧**逐像素同源**，从根上没有第二张画，也就没有可对不上的错位。

## 输出目录（每套动作一个文件夹，渲染端按名字拼路径）

  frames/idle-01..08.png      frames/blink-01..03.png
  frames/acting-01..08.png    frames/hips-01..08.png
  frames/happy-01..05.png     frames/pain-weak-01..06.png
  frames/pain-normal-01..06.png
  frames/critical-01..06.png  frames/revive-01..08.png
  states/critical-combo.png
  idle.png（托盘图标）

帧数一改，main.js 的 `ACTIONS` 里 `frames: [名字, 帧数]` 第二个数要同步 ——
那是**硬上限**（渲染端按它拼文件名），忘了改就是静默失败：桌面上只表现为
「动作少了一截」。这里 `prune()` 也会按本轮产出删掉旧帧，防止目录里留死文件。

另出 tools/_qa-frames.png 接触印相表。
"""
import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.stdout.reconfigure(encoding="utf-8")

# 素材根目录。默认就是本仓库；设 WHALEPET_ROOT 可以让生成器写到别处 ——
# 「改完先在临时目录里跑一遍、看一眼再落盘」用得上（别拿正式素材当试验田）。
ROOT = os.environ.get("WHALEPET_ROOT") or r"D:\WhalePet"
ASSET = os.path.join(ROOT, "assets", "shayu")
TOOLS = os.path.join(ROOT, "tools")

# ---- 画布与公共空间 ----
# 画布高度 480 → 458 → 428 → 462：
#   前三次是「把形象往上顶 + 收掉底部空白」（用户说的「形象和文字栏离得太远」）。
#   462 这一版是**换主体**带来的，两个数一起动了：
#     · hips 那张比 open 瘦（692 宽 vs 757）也高（773 vs 743），按面积算出 K 要 0.51
#       才能让它在画布里的**观感和原来持平**（原来形象占画布宽 88%，现在 86%）。
#       只改 K 不改画布的话，画布会装不下：内容底落在 y=440，只剩 6px 给动作的 dy。
#     · 所以画布高度跟着 K 涨到 462，留白回到「头顶 46px（9.9%）、底部 22px」。
# shared/petsize.js 的 CANVAS_H 必须同步改，tools/test-scale.js 拿真 PNG 头核对着这条。
CANVAS = (420, 462)
K = 0.51                 # 公共空间 → 画布
PAD = 80                 # 公共空间四周留白：给旋转/缩放留余量，避免切边
ANCHOR_X = 432           # 公共空间的水平锚点（人头中心附近），所有姿势共用
# 公共空间原点在画布上的纵向位置。3.3 是「把形象往上顶」的结果：33.3 时头顶上方空
# 74px（占画布 16.2%），而半身立绘通常只留 8~10%。3.3 之后头顶留白约 10%。
OY = 3.3
OX = CANVAS[0] / 2 - ANCHOR_X * K

# ---- 主体模板：叉腰那张的半身 ----
# hips 是全身站姿，剪影里最低的那条是腿。半身像不要腿 —— 但它自己的**尾巴**
# （x>430）一直垂到 y≈826，矩形裁到 800 会把尾鳍切掉一截（"生出两条腿之外
# 还少了尾巴尖"）。所以只把腿那一片抹透明。
LEG_TOP = 802            # 抹腿的基准行：蕾丝下沿最低也不会低过这里（实测 800~803）

# ---- 逐列切腿用的「暖粉」判据 ----
# 蕾丝下沿是**波浪形**的，一条直线切不干净：波谷处大腿根会从蕾丝缝里露出来
# （用户报的「裙子下面还能看到一点腿」），而波峰处蕾丝本身就低到线下，整条抬高又会
# 把蕾丝啃掉一口。所以逐列切，判据是**大腿根的暖粉**：
#   实测 腿的大腿根 R-G 25~42 / R-B 15~36；蕾丝褶皱 R-G 12~18 / R-B -6~+4。
# 两个条件缺一不可 —— 只卡 R-G 会把蕾丝褶皱算进来（切到花边），只卡 R-B 会把裙子上
# 那几颗**金色星星**算进来（R-B 上百，直接切到裙腰）。
LEG_WARM_RG = 20         # R - G 下限（暖）
LEG_WARM_RB = 8          # R - B 下限（粉，用来把金色饰品挡在外面）
LEG_SCAN_TOP = 770       # 逐列扫描起点：花边最高也高不过这里
LEG_SCAN_BOT = 836       # 逐列扫描终点：再往下没有花边，全是腿
LEG_X0, LEG_X1 = 242, 429   # 两条腿所在的列范围（左 245..307、右 361..423，各留几 px 余量）

# 每个姿势：源图 → 缩放 → 平移 →（可选）抹掉腿
#   open / shut 只用来提供眼睛像素：它们对齐在公共空间里，眼睛才能落到 hips 脸上。
#   wink（_sticker.png）**不参与合成**，所以 POSES 里没有它 —— 见文件头 ⑥。
POSES = {
    "open": dict(src="_sticker-open.png", scale=1.00, off=(0, 0)),
    "shut": dict(src="_sticker-shut.png", scale=1.00, off=(0, 0)),
    # 这里**没有 wink**（_sticker.png 眯眼·剪刀手那张）：它是另一套构图，整张搬进来
    # 会在 hips 的剪影里叠出第二套描边和荷叶边，只搬眼睛又会因为眼距/眼型不同而贴歪。
    # 它现在完全不参与合成 —— 理由见文件头 ⑥。
    "hips": dict(src="_sticker-hips.png", scale=0.94, off=(19, 1), legs=True),
}
# 公共空间尺寸：够放下所有姿势 + 平移 + 留白
COMMON = (820 + 2 * PAD, 860 + 2 * PAD)

# ---- 逐只眼的映射：**自动定标**，不再手标 ----
# 早先这两个锚点是拿网格图目测的，误差十几像素 —— 表现是闭眼顶到刘海、下面还残留一道
# 睁眼睫毛（用户报的「黑色线条」），而 EYE_K 手写成 1.02（实际应当**缩小**）让比例也错。
# 现在改成客观定标：**瞳孔**是虹膜正中、全图最暗、形状最稳的特征，两侧各找一个，
# 两点就定死了相似变换（位移 + 缩放）。见 detect_pupils()。
# 实测：open 瞳孔 (351.0,497.4)/(490.8,476.8) → hips (335.8,472.8)/(467.3,456.2)，
# 眼距 141.3 → 132.5，即 EYE_K = 0.938（而不是手写的 1.02）。
# 下面是同一套实测值，只是不重算 —— 检测失败时用它兜底。
OPEN_EYES = [(351.0, 497.4), (490.8, 476.8)]   # open 的左右瞳孔中心（公共空间）
HIPS_EYES = [(335.8, 472.8), (467.3, 456.2)]   # hips 的左右瞳孔中心
EYE_K = 0.938                                  # 单只眼的缩放（open → hips）
# 眼睛差异蒙版的阈值。keep 默认的 25/75：再收紧（90 以上）就补不全，
# 残留的睁眼虹膜会从闭眼下面透出来。
EYE_LO, EYE_HI = 25, 75
# 印「睫毛线」时的亮度上限：源图那块里低于它的像素才算线条（皮肤都在 200 以上）。
# 定得偏高一点没关系（反正只在眼部蒙版里取值），定低了线条会断成虚线。
LID_LUM = 150

# ---- 封闭白块（背景漏网）----
# 抠图（make-shayu-sticker.py）只从**画布四边**洪泛来判背景，判据是「近白且低饱和」。
# 问题是**被角色轮廓包住的背景**（尾巴根部那块、头发缝里的几块）洪泛进不去，
# 就被当成前景留成了不透明近白 —— 桌面上是「尾巴上方一块白、头发里几块白」，
# 压在深色壁纸上特别突兀。
#
# 这里在公共空间里补一刀：把「近白、不透明、成块」的像素抹透明，
# 但**保留合法白色**（头饰荷叶边 / 围裙 / 裙摆蕾丝 / 眼白）。
#
# 为什么不能纯自动：这些白块和荷叶边在颜色上几乎一样（都是暖白，R>G>B）；
# 背景渐变模型也分不开（白块 err 中位 7.7，裙摆蕾丝 9.8 —— 蕾丝反而更"不像背景"）；
# 「隔一条细墨线」这种几何判据同样不行（荷叶边外侧也只隔一条墨线）。
# 所以保留区是**标定出来的**，用法和 make-shayu-sticker.py 的 REF_HEM 一样。
HOLE_KEEP = [                 # 合法白色的区域（x0, y0, x1, y1），公共空间坐标
    (100, 90, 710, 335),      # 头饰荷叶边 + 左右蝴蝶结。x 左界原来 250 —— 憋出来一次
                              # 「桌面上头饰左边缺一块」：荷叶边最左那几瓣在 x≈130~250，
                              # 中心落在保留区外，整块 1700px 被当背景抹掉了
    (130, 540, 615, 860),     # 围裙 + 裙摆蕾丝 + 腰侧的白色饰带（左缘 x131 那条）
    (263, 420, 612, 550),     # 眼睛（眼白 / 高光）
]
HOLE_MIN = 60                 # 小于这个面积的块不动：描边抗锯齿的零星噪点

RED = (255, 70, 70)
GLOW_C = (255, 244, 205)

# （这里原来有一个 ARM_BOX = (512, 410, 660, 600)：happy 的滞空帧把 wink 的「比耶左臂」
#  剪下来贴到 hips 身上。已删掉 —— 那个窗口里 88% 的像素不是手，wink 的头发、荷叶边、
#  袖口都跟着搬了过来，在头发上留下一圈对不上的描边。详见文件头 ⑥。）

# blink 左眼闭眼的上移量（公共像素，正 = 上移）。标定：shut 的左眼睫毛线比右眼
# 低 22 帧像素，而两眼眼窝本身只差 ~8.6 帧 —— 差值就是要补的量。
EYE_DY_L = 26.0

# 额头刘海上的「亮蓝高光块」：原画的高光笔触，但颜色接近荷叶边白，深色壁纸下
# 看着像两处透明破洞（用户点名）。向周围头发基色收缩 65%，保留一点笔触质感。
BANG_BAND = (250, 240, 580, 340)     # 公共空间（x0, y0, x1, y1）
BANG_SHRINK = 1.0


# ---- 脸部净化：只保留「头发 + 眼睛 + 一对眉毛 + 嘴巴」----
# 标定来源：tools/_brow_grid.png（带 20px 网格的 _sticker-hips.png 放大图）。
# 眉毛是眼睛上方那道**细棕弧线**（实测 RGB 约 [157,120,112]），而粗黑的那道是
# 上眼睑 —— 属于眼睛，必须留。早期 fill_brow_lines 靠亮度阈值把两者一起当
# 「眉毛细线」删了，结果脸上光秃秃；这次反过来：只留眉毛窗口内的棕色层。
# 窗口给得比眉毛本体大（弧线尾巴渐细很难自动圈住），窗口内非眉毛像素照样被平涂。
#
# 下面是**公共空间**坐标：src → common 是 x*0.94+99、y*0.94+81（POSES["hips"]）。
# 坐标从 tools/_db_L.png / _db_R.png（公共空间、10px 网格）读出来：
#   · 右眉毛：细棕弧从 (430,420) 升到 (560,404)，厚约 6px
#   · 左眉毛：**被刘海压住**，只有靠鼻侧那截露出来，约 x 296..372、y 404..424
# 窗口比眉毛本体大一圈：抗锯齿边缘会往皮肤色褪，框死了会削掉眉毛尖。
BROW_KEEP = [
    (292, 400, 376, 428),          # 左眼上方（刘海压着，只留露出来的那截）
    (426, 398, 564, 430),          # 右眼上方那道完整弧
]


def fill_bang_highlights(im):
    a = np.asarray(im).astype(np.float32)
    x0, y0, x1, y1 = BANG_BAND
    rgb = a[:, :, :3]
    al = a[:, :, 3]
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    band = np.zeros(lum.shape, bool)
    band[y0:y1, x0:x1] = True
    hi = (al > 200) & (lum > 115) & (rgb[:, :, 2] - rgb[:, :, 0] > 15) & (mn < 225) & band
    if hi.sum() < 120:
        return im
    # 局部头发基色：band 内「普通头发」（暗、饱和蓝）的均值
    hair = band & (al > 200) & (lum < 110) & (rgb[:, :, 2] - rgb[:, :, 0] > 20)
    if hair.sum() < 300:
        return im
    base_col = rgb[hair].mean(axis=0)
    new_rgb = rgb.copy()
    new_rgb[hi] = base_col * BANG_SHRINK + rgb[hi] * (1 - BANG_SHRINK)
    out = a.copy()
    out[:, :, :3] = new_rgb
    res = Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")

    # 残点清理：全局基色填充后，掩码内外仍会留一些「比局部颜色亮/暗一截」的
    # 点状离群（用户截图里的三个点就是它们）。用 9×9 中值滤波当「局部应有的颜色」，
    # 离群超过 10 亮度的像素吃中值色 —— 点状的深浅残留一并压平，发丝大结构不动。
    band_rgb = np.asarray(res).astype(np.float32)
    med = np.asarray(Image.fromarray(band_rgb[:,:,:3].astype(np.uint8))
                     .filter(ImageFilter.MedianFilter(9))).astype(np.float32)
    blum = 0.299 * band_rgb[:, :, 0] + 0.587 * band_rgb[:, :, 1] + 0.114 * band_rgb[:, :, 2]
    mlum = 0.299 * med[:, :, 0] + 0.587 * med[:, :, 1] + 0.114 * med[:, :, 2]
    stray = (np.abs(mlum - blum) > 10) & (al > 200) & band
    sw = np.asarray(Image.fromarray((stray * 255).astype(np.uint8))
                    .filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255.0
    band_rgb[:, :, :3] = band_rgb[:, :, :3] * (1 - sw[:, :, None]) + med * sw[:, :, None]
    return Image.fromarray(band_rgb.clip(0, 255).astype(np.uint8), "RGBA")


def face_mask(rgb, al, ref_eyes):
    """脸部区域：一个**竖椭圆**脸型 ∩ 非头发 ∩ 非头饰白。

    早先这里用的是「取最大皮肤连通块」，有两个都致命的坑：
      · **白色荷叶边/ 围裙也是「亮、低蓝差」**，面积比脸还大 —— 最大块取到的是头饰，
        于是「脸颊基色」被算成 [248,245,243]（近白），整张脸被刷白；
      · 脸被刘海切断时皮肤分成好几块，取最大块会只拿到一块脸颊。
    现在改成**几何定界**：以两眼瞳孔中点为心，按眼距定rx/ry 的椭圆 —— 瞳孔
    由detect_pupils()客观定标，四张脸都适用，位置随构图自动跟随。
    再减掉「饱和蓝的头发」和「近白的荷叶边」，剩下的就是脸。

    返回 (脸区, 纯皮肤参考区)。皮肤参考区额外要求**不在眼/嘴/眉的暗红区域**，
    用来取基色。
    """
    a = rgb.astype(np.int16)
    lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    H, W = lum.shape

    ex = (ref_eyes[0][0] + ref_eyes[1][0]) / 2.0
    ey = (ref_eyes[0][1] + ref_eyes[1][1]) / 2.0
    d = ((ref_eyes[1][0] - ref_eyes[0][0]) ** 2 + (ref_eyes[1][1] - ref_eyes[0][1]) ** 2) ** 0.5
    if d < 40:
        return None, None
    # 瞳孔连线略斜（头是歪的），椭圆跟着转 —— 不然脸会缺一边。
    ang = np.degrees(np.arctan2(ref_eyes[1][1] - ref_eyes[0][1],
                                 ref_eyes[1][0] - ref_eyes[0][0]))
    # 实测标定（对照 tools/_d_area.png）：椭圆**上半**要盖住额头，下半到下巴就收。
    # rx 0.80d / ry 1.05d、心心下移 0.34d —— 早先的 0.95/1.30 会把脖子、肩膀、
    # 围裙蕾丝一起圈进来，脸区一大，「基色中位数」和「边缘描边」就都被带偏。
    rx, ry = 0.80 * d, 1.05 * d
    cy = ey + 0.34 * d
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    ca, sa = np.cos(np.radians(ang)), np.sin(np.radians(ang))
    dxr = (xx - ex) * ca + (yy - ey) * sa
    dyr = -(xx - ex) * sa + (yy - ey) * ca
    ell = (dxr / rx) ** 2 + ((dyr - 0.34 * d) / ry) ** 2 <= 1.0

    opaque = al > 200
    hair = (a[:, :, 2] - a[:, :, 0] > 32) | (lum < 120)      # 饱和蓝头发 / 描边
    frill = (mn >= 226) & ((mx - mn) <= 26)# 近白：荷叶边、围裙、袖口
    area = ell & opaque & (~hair) & (~frill)
    if area.sum() < 4000:
        return None, None
    # 纯皮肤参考：**眼睛正下方那一小块**（鼻梁上段）。
    # 早先试过两种取法都不稳：①「脸区里亮且低红差」——闭眼帧眼窝填充留下的
    # [255,250,244] 死白把中位数拽到[237,217,211]，脸发灰；②「暖色脸颊」——
    # 又被腮红拽到 [249,202,191]，脸发红。最后干脆**按几何取**：瞳孔往下
    # 0.35~0.75 眼距、横向夹在两眼之间，这一块既避开了眼白/睫毛/腮红/嘴，
    # 又是纯皮肤（实测 [252,231,223]），四张脸的肤色基色全靠它定。
    skin_px = np.zeros(lum.shape, bool)
    mx0, mx1 = int(min(ref_eyes[0][0], ref_eyes[1][0])), int(max(ref_eyes[0][0], ref_eyes[1][0]))
    skin_px[int(ey + 0.35 * d):int(ey + 0.75 * d), mx0:mx1] = True
    skin_px &= area & (al > 200)
    if skin_px.sum() < 300:
        #闭眼/眯眼合成帧：鼻子那块已经被眼窝填充占掉，采样点不够。
        # 放宽成「脸区里中等亮度、且不是死白」的全部像素（闭眼帧的死白
        # [255,250,244] 被mn<212 挡掉，不会再把基色拽灰）。
        skin_px = area & (al > 200) & (mn < 212) & (lum > 168)
    if skin_px.sum() < 150:
        skin_px = area & (al > 200)
    return area, skin_px


# 统一肤色基准：第一次 clean_face（主体 hips，那张脸最完整）测出来，
# 之后所有表情帧都复用它。
# 为什么不用逐帧各测：闭眼帧的眼窝填充会占掉鼻子那块采样点，退回全脸取中位数
# 时又混进了眼白的残留，基色实测从 [250,228,219] 漂到 [241,214,206] —— 桌面上
# 就是「眨眼时脸忽然暗一档」。主体帧的脸最干净，量出来最准。
SKIN_REF = [250.0, 228.0, 219.0]


def clean_face(im, eyes, calibrate_skin=False):
    """把脸整张统一成「只有头发 + 眼睛 + 一对眉毛 + 嘴巴，其余全是皮肤」。

    用户反复报的脸上异物（额头亮点、眉心竖线、脸颊上的细道、腮红里的杂点、
    被搬运错位的眉毛、闭眼帧脸颊上的彩色斑块）本质是同一类问题：
    **五官之外还有别的东西画在脸上**。逐个点位去补补不完 —— 改成整张脸重画：

      ① face_mask() 用两眼瞳孔定出脸区（椭圆随构图自动跟随，见该函数注释）；
      ② 脸里只认**四样要保留的**：
         · 眼睛 —— 以瞳孔为中心的椭圆（不是「所有暗像素」，否则闭眼帧那条
           残留的睫毛游丝、腮红里的暗点都会被当成眼睛留下）；
         · 嘴巴 —— 眼下的偏红块；
         · 一对眉毛 —— 标定窗口内那层低饱和中暗棕（见 BROW_KEEP）；
         · 脸的轮廓描边 —— 脸区最外几像素的暗色，删了脸会「散」开。
      ③ 剩下的全部填成皮肤。填色**不是**取邻域插值（那会把眉毛、刘海的深蓝
         拉下来），而是取脸颊皮肤的**中位色**整片平涂，再叠一层 16px 高斯模糊
         出来的低频明暗 —— 大尺度立体感（鼻梁高光、腮红）还在，细线、色斑、
         碎点全没了。

    `eyes` 传该姿势自己的瞳孔坐标：open 用它自己的定标结果，shut/合成帧用 hips 的。
    """
    a = np.asarray(im).astype(np.int16)
    al = a[:, :, 3]
    rgb = a[:, :, :3].astype(np.float32)
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    br = rgb[:, :, 2] - rgb[:, :, 0]
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)

    area, skin_px = face_mask(rgb, al, eyes)
    if area is None:
        print("  !! 脸区定位失败，跳过这张的脸部净化")
        return im

    H, W = lum.shape
    d = ((eyes[1][0] - eyes[0][0]) ** 2 + (eyes[1][1] - eyes[0][1]) ** 2) ** 0.5
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

    # ② 眼睛：以瞳孔为中心的椭圆（rx/0.62d、ry/0.52d —— 覆盖眼白+虹膜+上下睫毛）
    keep = np.zeros(lum.shape, bool)
    for ex, ey in eyes:
        t = ((xx - ex) / (0.62 * d)) ** 2 + ((yy - ey) / (0.52 * d)) ** 2
        keep |= t <= 1.0
    keep &= area | (al > 0)          # 椭圆内但透明的（脸的边界外）不算

    # ② 嘴巴：眼下的偏红块
    mouth = (al > 200) & area & (rgb[:, :, 0] - rgb[:, :, 2] > 40) & (rgb[:, :, 0] > 135) \
        & (yy > eyes[0][1] + 0.35 * d) & (yy < eyes[0][1] + 1.45 * d)
    keep |= np.asarray(Image.fromarray((mouth * 255).astype(np.uint8))
                       .filter(ImageFilter.MaxFilter(5))) > 128

    # ② 眉毛：标定窗口内那层低饱和中暗棕（实测 [157,120,112] 一带）。
    # 用色相（R>G>B）而不是亮度来认—— 窗口里还有刘海的深蓝和皮肤的亮色。
    brow_win = np.zeros(lum.shape, bool)
    for x0, y0, x1, y1 in BROW_KEEP:
        brow_win[y0:y1, x0:x1] = True
    # 判据是「**比周围皮肤明显暗**」，不是绝对色。眉毛只有 1~2 像素宽、又是
    # 抗锯齿画出来的，纯色像素极少 —— 早先按绝对色（暖 + 中暗）筛，窗口里
    # 1478 个候选只落中 16px，眉毛几乎被自己抹平。改成局部相对暗度：
    # 拿亮度的 12px 高斯模糊当「这里的皮肤本该多亮」，比它暗 28 以上就是眉毛。
    # 这样刘海（暗但成片）、上眼睑（更暗且在窗口外）都不会被误当成眉毛。
    bg = np.asarray(Image.fromarray(lum.astype(np.uint8))
                    .filter(ImageFilter.GaussianBlur(12))).astype(np.float32)
    brow = brow_win & (al > 200) & ((bg - lum) > 26)
    brow = np.asarray(Image.fromarray((brow * 255).astype(np.uint8))
                      .filter(ImageFilter.MinFilter(3))) > 128   # 去掉抗锯齿碎点
    keep |= brow

    # 脸的外轮廓描边：脸区最外 3px 的暗像素。删了脸会散，但**刘海压脸的那条边**
    # 也在这圈里，所以只认「比皮肤暗不少」的那部分，别把刘海的蓝边当描边。
    # 另加一条：脸区里**不透明但既不是皮肤、也不属于任何五官**的孤立小块
    # （荷叶边蹭进脸区的白、描边断点）也一起平涂。
    edge = area & ~np.asarray(Image.fromarray((area * 255).astype(np.uint8))
                              .filter(ImageFilter.MinFilter(9))) > 128
    keep |= edge & (al > 200) & (lum < 165) & (br < 45)
    # 脸里**任何近白色**都不该保留。两类来源：
    #   · 荷叶边蹭进脸区的白边（脸颊两侧那两块）；
    #   · 闭眼帧build_closed_eyes() 用 skin_fill() 填眼窝时，行插值从旁边
    #     的白（眼白/荷叶边）拉进来的 [255,250,244] —— 桌面上是脸颊一片死白。
    # 判据取mn>214：比皮肤（[251,229,220]，mn=220）略低一点，
    # 腮红的粉（[247,180,166]，mn=166）远够不到，不会被误伤。
    # 脸里**任何近白色**都不该保留。三类来源：
    #   · 荷叶边蹭进脸区的白边（脸颊两侧那两块）；
    #   · 抗锯齿过渡色 [247,235,231] / [255,241,232] —— 纯白卡阈值会漏；
    #   · 闭眼帧 build_closed_eyes() 用 skin_fill() 填眼窝时，行插值从旁边的
    #     眼白拉进来的 [255,250,244]（桌面上是脸颊一片死白）。
    # 判据用「**到皮肤基色的距离 + 低饱和**」而不是 mn 阈值：夹在白与皮肤之间的
    # 过渡色 mn 也在 200~245 之间，卡哪一头都会漏一半。腮红 [247,180,166]
    # 离基色 72、饱和度也高，稳稳在保留区外。
    near_white = (((rgb - np.array(SKIN_REF, dtype=np.float32)[None, None, :]) ** 2)
                  .sum(axis=2) ** 0.5 < 30) & ((mx - mn) < 46)
    keep &= ~near_white

    # ③ 其余全是皮肤 → 平涂脸颊中位色
    # 肤色基准**只能有一个来源**：主体帧（build_frames 里传 calibrate_skin=True）。
    # 早先是「谁采到 300 个采样点谁就就地改基准」，于是表情帧也会改掉它：
    # 由 wink 混合出来的那张脸被量成 [245,203,190]（混进了另一套画的腮红），
    # 基准一改，**之后每一张脸**都跟着偏红。
    if calibrate_skin and skin_px.sum() >= 300:
        SKIN_REF[:] = np.median(rgb[skin_px], axis=0).tolist()
    col = np.array(SKIN_REF, dtype=np.float32)
    fill_mask = area & (~keep) & (al > 200)
    if fill_mask.sum() < 200:
        return im
    # 低频明暗：把原图重度模糊后当作色调调制，纯平涂会让脸变成一块死板色片。
    shade = np.asarray(Image.fromarray(rgb.astype(np.uint8))
                       .filter(ImageFilter.GaussianBlur(16))).astype(np.float32)
    tone = np.clip(shade / np.clip(np.mean(shade[skin_px], axis=0), 1e-3, None), 0.94, 1.06)
    new = col[None, None, :] * tone
    # 边缘羽化：硬切会在脸的轮廓内侧留一圈「平涂色边」
    soft = np.asarray(Image.fromarray((fill_mask * 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(2.0))).astype(np.float32) / 255.0
    m3 = np.clip(fill_mask[:, :, None].astype(np.float32) * 0.4 + soft[:, :, None] * 0.7, 0, 1)
    out = a.astype(np.float32).copy()
    out[:, :, :3] = rgb * (1 - m3) + new * m3
    print("  脸部净化：脸区 %d，保留 眼 %d / 嘴 %d / 眉 %d，平涂 %d，基色 %s"
          % (int(area.sum()), int(keep.sum()), int(mouth.sum()), int(brow.sum()),
             int(fill_mask.sum()), col.astype(int).tolist()))
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")


def _blobs(mask, min_px, conn8=False):
    """4/8 邻域连通块：[(像素数, 中心x, 中心y, 宽, 高), ...]（够大的才留）。"""
    H, W = mask.shape
    seen = np.zeros_like(mask)
    nb = ((1, 0), (-1, 0), (0, 1), (0, -1))
    if conn8:
        nb = nb + ((1, 1), (1, -1), (-1, 1), (-1, -1))
    out = []
    ys, xs = np.where(mask)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        q = deque([(sy, sx)])
        seen[sy, sx] = True
        n = 0
        ax = ay = 0
        x0 = x1 = sx
        y0 = y1 = sy
        while q:
            y, x = q.popleft()
            n += 1
            ax += x
            ay += y
            x0, x1 = min(x0, x), max(x1, x)
            y0, y1 = min(y0, y), max(y1, y)
            for dy, dx in nb:
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if n >= min_px:
            out.append((n, ax / float(n), ay / float(n), x1 - x0 + 1, y1 - y0 + 1))
    return out


def drop_hole_white(im, keep=HOLE_KEEP, min_px=HOLE_MIN):
    """抹掉「封闭背景」漏成的近白块（尾巴根部、头发缝里那种）。返回 (图, 抹掉像素数)。

    判据刻意简单：**近白 + 不透明 + 成块 + 不在保留区**。
    保留区保护的是合法白色（荷叶边 / 围裙 / 裙摆蕾丝 / 眼白），见 HOLE_KEEP 的说明。
    """
    arr = np.asarray(im)
    al = arr[:, :, 3]
    rgb = arr[:, :, :3].astype(np.int16)
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    m = (al > 200) & (mn >= 228) & ((mx - mn) <= 22)
    if not m.any():
        return im, 0
    keepm = np.zeros_like(m)
    for x0, y0, x1, y1 in keep:
        keepm[y0:y1, x0:x1] = True

    # 逐块判定（8 邻域，抗锯齿的斜向连接也要算同一块）
    H, W = m.shape
    seen = np.zeros_like(m)
    nb = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
    drop = np.zeros_like(m)
    kept = 0
    ys, xs = np.where(m)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        q = deque([(sy, sx)])
        seen[sy, sx] = True
        comp = []
        while q:
            y, x = q.popleft()
            comp.append((y, x))
            for dy, dx in nb:
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and m[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(comp) < min_px:
            continue
        cy = int(round(sum(p[0] for p in comp) / float(len(comp))))
        cx = int(round(sum(p[1] for p in comp) / float(len(comp))))
        if keepm[cy, cx]:
            kept += 1
            continue
        for y, x in comp:
            drop[y, x] = True

    if not drop.any():
        return im, 0
    out = arr.copy()
    out[:, :, 3] = np.where(drop, 0, out[:, :, 3])
    return Image.fromarray(out, "RGBA"), int(drop.sum())


def detect_pupils(im, label=""):
    """找两只瞳孔的中心（公共空间坐标）。找不到返回 None。

    瞳孔是虹膜正中那团最暗的像素：全图亮度最低、形状接近圆、左右各一个。判据写得死板
    （亮度阈值扫 55/62/70/80，只接受「两个大小接近、高度接近、水平分开 80~260px」的一对），
    因为**找错瞳孔比找不到更糟** —— 找不到还能回落到实测常量，找错了整张脸就贴歪了。
    """
    a = np.asarray(im).astype(np.int16)
    al = a[:, :, 3]
    lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]
    band = np.zeros(lum.shape, bool)
    band[400:545, 250:670] = True
    best = None
    for th in (55, 62, 70, 80):
        cand = [b for b in _blobs((lum < th) & (al > 200) & band, 60)
                if 90 <= b[0] <= 520 and 8 <= b[3] <= 34 and 8 <= b[4] <= 34
                and 0.45 < b[0] / float(b[3] * b[4]) < 1.05]
        for i in range(len(cand)):
            for j in range(i + 1, len(cand)):
                b1, b2 = cand[i], cand[j]
                if b1[1] > b2[1]:
                    b1, b2 = b2, b1
                dx, dy = b2[1] - b1[1], abs(b2[2] - b1[2])
                if not (80 <= dx <= 260 and dy <= 40):
                    continue
                ar = min(b1[0], b2[0]) / float(max(b1[0], b2[0]))
                if ar < 0.6:
                    continue
                score = ar * 2 - dy / 40.0 - abs(b1[3] - b2[3]) / 30.0
                if best is None or score > best[0]:
                    best = (score, [(b1[1], b1[2]), (b2[1], b2[2])])
    if best is None:
        print("  !! %s 找不到成对瞳孔，眼睛映射回落到实测常量" % label)
        return None
    return best[1]


def calibrate_eyes(C):
    """用瞳孔定死逐眼映射（位移 + 缩放）。任何一边失败就整体回落到实测常量。"""
    global OPEN_EYES, HIPS_EYES, EYE_K
    po = detect_pupils(C["open"], "open")
    ph = detect_pupils(C["hips"], "hips")
    if not po or not ph:
        print("  眼睛定标：沿用实测常量  EYE_K=%.3f" % EYE_K)
        return
    do = ((po[1][0] - po[0][0]) ** 2 + (po[1][1] - po[0][1]) ** 2) ** 0.5
    dh = ((ph[1][0] - ph[0][0]) ** 2 + (ph[1][1] - ph[0][1]) ** 2) ** 0.5
    OPEN_EYES, HIPS_EYES, EYE_K = po, ph, dh / do
    print("  眼睛定标：瞳孔 open (%.1f,%.1f)/(%.1f,%.1f) → hips (%.1f,%.1f)/(%.1f,%.1f)"
          % (po[0][0], po[0][1], po[1][0], po[1][1], ph[0][0], ph[0][1], ph[1][0], ph[1][1]))
    print("            眼距 %.1f → %.1f   EYE_K=%.4f" % (do, dh, EYE_K))


def drop_legs(im):
    """抹掉腿（半身像不要腿）：逐列跟着裙摆蕾丝的下沿切。

    hips 是全身站姿，剪影里最低的那条是腿；但它自己的**尾巴**（x>430）一直垂到 y≈824，
    按矩形裁到裙摆下沿会把尾鳍连着切掉 —— 所以只动腿那一片（LEG_X0..LEG_X1）。

    早先这一片是**一条直线**（y>=LEG_TOP 全抹）。蕾丝下沿是波浪形的，于是波谷处露出来的
    大腿根留了下来 —— 用户看到的「裙子下面还能看到一点腿」就是它。现在逐列找**暖粉**
    （见 LEG_WARM_RG/RB 的注释：蕾丝褶皱和金色星星都够不到那个暖度），在它上面一行切；
    没找到暖粉的列（两腿之间那道缝、纯蕾丝）沿用 LEG_TOP。实测切线只在 792~802 之间波动，
    正好是花边波谷的位置。
    """
    a = np.asarray(im).copy()
    rgb = a[:, :, :3].astype(np.int16)
    al = a[:, :, 3]
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    warm = ((rgb[:, :, 0] - rgb[:, :, 1] >= LEG_WARM_RG)
            & (rgb[:, :, 0] - rgb[:, :, 2] >= LEG_WARM_RB)
            & (al > 200) & (lum > 150))
    y1 = min(LEG_SCAN_BOT, a.shape[0])
    raised = 0
    for x in range(LEG_X0, LEG_X1):
        top = LEG_TOP
        for y in range(LEG_SCAN_TOP, y1):
            if warm[y, x]:
                top = min(LEG_TOP, y - 1)
                break
        if top < LEG_TOP:
            raised += 1
        a[top:, x, 3] = 0
    print("  抹腿：%d 列跟着蕾丝下沿抬高（其余列仍从 y=%d 抹）" % (raised, LEG_TOP))
    return Image.fromarray(a, "RGBA")


def load_pose(p):
    im = Image.open(os.path.join(ASSET, p["src"])).convert("RGBA")
    if p.get("legs"):
        im = drop_legs(im)
    s = p["scale"]
    if s != 1.0:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    return im


def load_common():
    """把三张素材按 POSES 的变换放进同一个公共空间，再补一刀「封闭白块」。

    白块这一刀放在公共空间里做（不是各姿势自己的坐标里）：四个姿势已经对齐，
    一套保留区就够，不用为每张图各标一份。
    """
    out = {}
    for key, p in POSES.items():
        im = load_pose(p)
        canvas = Image.new("RGBA", COMMON, (0, 0, 0, 0))
        canvas.alpha_composite(im, (PAD + p["off"][0], PAD + p["off"][1]))
        out[key] = canvas
    total = 0
    parts = []
    for key in out:
        out[key], n = drop_hole_white(out[key])
        total += n
        parts.append("%s %d" % (key, n))
    print("  抹掉封闭白块 %d px（%s）" % (total, " · ".join(parts)))
    # 脸部净化放在**公共空间**里做（四个姿势已对齐，一套脸区标定就够）：
    # 先各自清额头高光（刘海那两处亮点在脸上，脸区掩罩会把它当成「脸上的东西」
    # 一起平掉，但不同姿势的高光位置略有偏差，先各自填更稳），再统一重画脸。
    for key in out:
        out[key] = fill_bang_highlights(out[key])
    # **脸部净化不在这里做** —— 它要用瞳孔定标来圈脸区，而定标（calibrate_eyes）
    # 得等三张都进公共空间之后才能跑。统一挪到 build_frames() 里 eyes 定标之后。
    return out


# frill_box() / align_wink_to_hips() 随 wink 一起删了：它们只服务于
# 「把 wink 当整图搬」那套对齐。


def content_bottom(im):
    """内容最低的那一行 —— 挤压/平移都以它为锚。"""
    a = np.asarray(im)[:, :, 3]
    ys = np.where((a > 16).any(axis=1))[0]
    return int(ys.max()) if len(ys) else 0


# ---------------- 表情：把 open 坐标的眼睛搬到 hips 脸上 ----------------

def _affine_for(half, k, dy_shift=0.0):
    """PIL 的 AFFINE 要的是「输出坐标（hips）→ 输入坐标（open）」的逆映射。

    dy_shift：输出在 y 方向整体偏移（**正 = 上移**）。shut 的左眼闭眼在源画里
    就画得偏低（AI 两张图的眼睛高度不一致），搬到 hips 后睫毛线比右眼低 22 帧
    像素，表现是「左眼闭眼掉到眼睛底部」—— L 半区要整体上移补偿。
    """
    i = 0 if half == "L" else 1
    sx, sy = OPEN_EYES[i]
    dx, dy = HIPS_EYES[i]
    return (1.0 / k, 0, sx - dx / k, 0, 1.0 / k, sy - dy / k + dy_shift / k)


def warp_eye(im, half, k=EYE_K, fill=(0, 0, 0, 0), dy_shift=0.0):
    """按该眼的映射搬一半（half='L'/'R'），另一半留空。"""
    a, b, c, d, e, f = _affine_for(half, k, dy_shift)
    fill = 0 if im.mode == "L" else fill
    out = im.transform(im.size, Image.AFFINE, (a, b, c, d, e, f),
                       resample=Image.BICUBIC, fillcolor=fill)
    mid = int((HIPS_EYES[0][0] + HIPS_EYES[1][0]) / 2)
    box = (0, 0, mid, im.height) if half == "L" else (mid, 0, im.width, im.height)
    keep = Image.new(out.mode, out.size, fill)
    keep.paste(out.crop(box), (box[0], 0))
    return keep


def eye_weight(base, other, sigma=6, lo=25, hi=75):
    """base 与 other 的差异权重（0~1）。只在眼睛附近有值。

    现在只用来**打日志**（看看蒙版有多大，换素材时能看出标定有没有崩），
    不再参与眼区的圈选 —— 圈选改用椭圆了（见 build_expression 的 ①）。
    """
    b = np.asarray(base.convert("RGB")).astype(np.float32)
    o = np.asarray(other.convert("RGB")).astype(np.float32)
    solid = (np.asarray(base)[:, :, 3] > 200) & (np.asarray(other)[:, :, 3] > 200)
    d = np.abs(b - o).max(axis=2)
    d[~solid] = 0.0
    d = np.asarray(Image.fromarray(d.astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma))).astype(np.float32)
    w = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
    return np.asarray(Image.fromarray((w * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4))).astype(np.float32) / 255.0


def skin_fill(arr_rgb, hole):
    """把 hole 盖住的像素填成同一行左右两侧的插值（只改洞里，别动整行）。"""
    ys, xs = np.where(hole)
    if len(ys) == 0:
        return arr_rgb
    y0, y1 = max(0, ys.min() - 6), min(arr_rgb.shape[0], ys.max() + 7)
    x0, x1 = max(0, xs.min() - 6), min(arr_rgb.shape[1], xs.max() + 7)
    out = arr_rgb.copy()
    sub = out[y0:y1, x0:x1, :]
    h = hole[y0:y1, x0:x1]
    Hh, Ww = h.shape
    xs_all = np.arange(Ww)
    for y in range(Hh):
        hrow = h[y]
        if not hrow.any():
            continue
        ok = np.where(~hrow)[0]
        if len(ok) < 2:
            continue
        for c in range(3):
            vals = np.interp(xs_all, ok, sub[y, ok, c])
            sub[y, hrow, c] = vals[hrow]
    return out


def tidy_eye(rgb, alpha, eye, max_px=150, dev=22, rx_k=0.45, ry_k=0.36):
    """眼里**只留最大的那一块墨**（闭眼睫毛线），其余零碎墨点/亮点填成皮肤。

    两样东西靠它清掉，都是「贴闭眼」带进来的：
      · **原画睁眼的睫毛/眼睑残迹** —— 眼窝只盖瞳孔周围那一圈，这几笔留在蒙版外面，
        和新贴的闭眼叠成两道线（用户报的「杂乱线条」）；
      · **shut 那张自己的高光点** —— 它跟着蒙版一起搬过来，落在眼睑上就是个白斑。

    判据：瞳孔附近的小椭圆里，「比 9px 局部亮度差 22 以上」的像素算候选墨点；按 8 邻域
    连通后**只留最大的那一块**（睫毛线大，残迹和高光都是小块），其余 ≤max_px 的块按行
    插值填成皮肤并羽化。眉毛窗口（BROW_KEEP）整个排除 —— 正经五官不能当墨点清
    （第一版忘了排除，把刘海边缘也啃掉了一块）。

    椭圆刻意取小（0.45/0.36 眼距）：只够罩住眼睛，碰不到刘海和脸颊。
    实测每只眼清掉 60~70 px / 5~7 块。
    """
    px, py = eye
    d = ((HIPS_EYES[1][0] - HIPS_EYES[0][0]) ** 2 + (HIPS_EYES[1][1] - HIPS_EYES[0][1]) ** 2) ** 0.5
    H, W = alpha.shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    local = np.asarray(Image.fromarray(lum.astype(np.uint8))
                       .filter(ImageFilter.GaussianBlur(9))).astype(np.float32)
    ell = (((xx - px) / (rx_k * d)) ** 2 + ((yy - py) / (ry_k * d)) ** 2) <= 1.0
    cand = ell & (alpha > 200) & (np.abs(lum - local) > dev)
    for x0, y0, x1, y1 in BROW_KEEP:
        cand[y0:y1, x0:x1] = False
    if not cand.any():
        return rgb, 0

    seen = np.zeros_like(cand)
    blocks = []
    for sy, sx in zip(*np.where(cand)):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        pix = []
        while stack:
            y, x = stack.pop()
            pix.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and cand[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        if len(pix) > 1:
            blocks.append(pix)
    if len(blocks) < 2:
        return rgb, 0                      # 只剩睫毛线一块 → 没东西要清
    blocks.sort(key=len, reverse=True)     # [0] = 最大的那块 = 睫毛线，留着
    drop = np.zeros_like(cand)
    for pix in blocks[1:]:
        if len(pix) > max_px:
            continue                       # 大到这个份上就不是残迹了，别动它
        for y, x in pix:
            drop[y, x] = True
    if drop.sum() < 4:
        return rgb, 0
    fixed = skin_fill(rgb, drop)
    soft = np.asarray(Image.fromarray((drop * 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(1.3))).astype(np.float32) / 255.0
    return rgb * (1 - soft[:, :, None]) + fixed * soft[:, :, None], int(drop.sum())


def build_closed_eyes(C, half=None):
    """把 shut 那张的「闭眼」贴到 hips 脸上（半区可选中），三步：

    half=None → 两只都闭（眨眼用）；half="L"/"R" → **只闭那一只**（happy 的滞空帧
    要的是眨一只眼，另一只保持 hips 原样，所以另一个半区一个像素都不动）。
    命名按公共空间坐标：L = 画面左侧那只（HIPS_EYES[0]，角色的右眼），
    R = 画面右侧那只（HIPS_EYES[1]，角色的左眼）—— 「眨个左眼」是 R。

    shut 源画里**左眼的闭眼就画得偏低**（比右眼低 22 帧像素；AI 两张图的眼睛高度
    不一致，瞳孔定标只对齐了「眼睛中心」，盖不住这个构图差）。直接按蒙版贴，
    睫毛线落到原眼窝底部，原睁眼的**上睫毛**留在闭眼上方成一条孤立黑线，虹膜
    下半也从下面露出来 —— 用户看到的「左眼上方黑线」「闭眼位置不对」都是它。

    ① 眼窝软椭圆（rx=0.31·眼距, ry=0.24·眼距，以该眼瞳孔为心）内的
       原眼内容（虹膜/眼白/上睫毛/下眼睑/外眼角）**填成脸颊皮肤**——行插值 +
       填充区色调对齐（以椭圆外沿的脸颊本尊为基准），填充后模糊柔化插值条痕。
       **选中哪只眼就填哪只**：早先只填 L（blink 两只都闭，R 的闭眼正好盖住原眼，
       不填也看不出来），只闭一只时没被盖住的那半会把原虹膜/睫毛露在闭眼旁边。
       眼窝**不能再放大**：放大了虽然能盖住原眼残迹，但蒙版盖住的那一大片贴的是 shut
       那张自己的脸（比叉腰这张白），整个眼睑会变成一块发白的平板。残迹改用 ④ 清。
    ② L 半区的闭眼和蒙版**整体上移 EYE_DY_L**（公共像素），睫毛线回到与右眼同高。
    ③ 蒙版 = 差异蒙版 ∪ 闭眼轮廓 ∩ 软椭圆 —— 保证虹膜/残影全被盖住。
    ④ tidy_eye()：眼里**只留那条闭眼睫毛线**，清掉原画残迹和 shut 自己的高光点。
    """
    OPEN, SRC, HIPS = C["open"], C["shut"], C["hips"]
    alpha = np.asarray(HIPS)[:, :, 3].astype(np.float32)
    d = ((HIPS_EYES[1][0] - HIPS_EYES[0][0]) ** 2 + (HIPS_EYES[1][1] - HIPS_EYES[0][1]) ** 2) ** 0.5
    b = np.asarray(HIPS).astype(np.float32)[:, :, :3]
    # 眼窝**只能盖住瞳孔周围那一圈**，不能放大：蒙版盖到哪里，那里就换成 shut 那张的
    # 像素 —— 而 shut 是另一次生成的脸，皮肤比叉腰这张白。放大到 0.46/0.34（试过）会把整个
    # 眼睑贴成一块发白的平板，桌面上就是「眨眼时原本的位置变成白色」。代价是原画睁眼的
    # 睫毛残迹会留在蒙版外面 —— 那由 ④ 的 tidy_eye() 清掉，不是靠放大眼窝硬盖。
    rx, ry = 0.31 * d, 0.24 * d
    lift = 0.005 * d      # 椭圆中心比瞳孔略低 —— 原标定值
    yy, xx = np.mgrid[0:HIPS.size[1], 0:HIPS.size[0]].astype(np.float32)
    halves = ("L", "R") if half is None else (half,)
    mid = int((HIPS_EYES[0][0] + HIPS_EYES[1][0]) / 2)

    # ① 眼窝填皮肤（选中哪只填哪只），② 蒙版与闭眼像素（L 半区补 EYE_DY_L 的高差）
    sockets = {}
    for h in halves:
        px, py = HIPS_EYES[0 if h == "L" else 1]
        t = ((xx - px) / rx) ** 2 + ((yy - py + lift) / ry) ** 2
        soft = np.clip((1.08 - t) / 0.26, 0, 1)
        hole = soft > 0.5
        fill = skin_fill(b, hole)
        ring_out = (soft > 0.02) & (soft < 0.45) & (alpha > 230)
        if ring_out.sum() > 200:
            gain = (b[ring_out].mean(axis=0) + 1e-3) / (fill[hole].mean(axis=0) + 1e-3)
            gain = np.clip(gain, 0.85, 1.35)
            fill[hole] = np.clip(fill[hole] * gain, 0, 255)
        fl_blur = np.asarray(Image.fromarray(fill.astype(np.uint8))
                             .filter(ImageFilter.GaussianBlur(5))).astype(np.float32)
        soften = np.asarray(Image.fromarray((hole * 255).astype(np.uint8))
                            .filter(ImageFilter.GaussianBlur(3))).astype(np.float32) / 255.0
        sockets[h] = (soft, fill * (1 - soften[:, :, None]) + fl_blur * soften[:, :, None])

    wimg = Image.fromarray((eye_weight(OPEN, SRC, lo=EYE_LO, hi=EYE_HI) * 255).astype(np.uint8), "L")
    moved = Image.new("RGBA", HIPS.size, (0, 0, 0, 0))
    mask = np.zeros((HIPS.size[1], HIPS.size[0]), np.float32)
    socket_fill = b.copy()
    for h in halves:
        dd = EYE_DY_L if h == "L" else 0.0
        soft, fill = sockets[h]
        mv = warp_eye(SRC, h, dy_shift=dd)
        moved.alpha_composite(mv)
        mh = np.asarray(warp_eye(wimg, h, fill=0, dy_shift=dd)).astype(np.float32) / 255.0
        mh = np.maximum(mh, soft * (np.asarray(mv)[:, :, 3] > 10))
        mask = np.maximum(mask, mh)
        x0, x1 = (0, mid) if h == "L" else (mid, HIPS.size[0])
        socket_fill[:, x0:x1] = fill[:, x0:x1]

    o = np.asarray(moved).astype(np.float32)
    has_pix = (o[:, :, 3] > 40).astype(np.float32)
    # 闭眼有像素的地方用闭眼，其余（虹膜/残影区）用**那只眼自己的**皮肤填充
    src_rgb = o[:, :, :3] * has_pix[:, :, None] + socket_fill * (1 - has_pix[:, :, None])
    blum = 0.299 * b[:, :, 0] + 0.587 * b[:, :, 1] + 0.114 * b[:, :, 2]
    ring = (mask > 0.15) & (mask < 0.60) & (blum > 185) & (o[:, :, 3] > 40)
    if ring.sum() > 200:
        gain = (b[ring].mean(axis=0) + 1e-3) / (src_rgb[ring].mean(axis=0) + 1e-3)
        gain = np.clip(gain, 0.80, 1.25)
        src_rgb = np.clip(src_rgb * gain, 0, 255)
    w = np.clip(mask * 1.25, 0.0, 1.0)[:, :, None]
    rgb = b * (1 - w) + src_rgb * w
    olum = 0.299 * src_rgb[:, :, 0] + 0.587 * src_rgb[:, :, 1] + 0.114 * src_rgb[:, :, 2]
    ink = np.clip((LID_LUM - olum) / 45.0, 0.0, 1.0) * (mask > 0.10) * (o[:, :, 3] > 90)
    rgb = rgb * (1 - ink[:, :, None]) + src_rgb * ink[:, :, None]
    # ④ 眼里只留那条闭眼睫毛线
    for h in halves:
        rgb, dropped = tidy_eye(rgb, alpha, HIPS_EYES[0 if h == "L" else 1])
        if dropped:
            print("  闭眼清理（%s 眼）：抹掉 %d px 零碎墨点/亮点" % (h, dropped))
    return clean_face(Image.fromarray(np.dstack([rgb, alpha]).clip(0, 255).astype(np.uint8), "RGBA"), HIPS_EYES)


def eye_gate(size, eyes, rx=0.72, ry=0.62, feather=0.30):
    """两只眼睛的软椭圆闸门（1 = 眼区，0 = 眼睛以外）。标定和 clean_face 同一套。"""
    W, H = size
    d = ((eyes[1][0] - eyes[0][0]) ** 2 + (eyes[1][1] - eyes[0][1]) ** 2) ** 0.5
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = np.zeros((H, W), np.float32)
    for ex, ey in eyes:
        t = ((xx - ex) / (rx * d)) ** 2 + ((yy - ey) / (ry * d)) ** 2
        g = np.maximum(g, np.clip((1.0 + feather - t) / feather, 0.0, 1.0))
    return g


def build_expression(C, src_key):
    """把 src_key 那张的眼睛搬到 hips 脸上。三步：

    **① 眼区 = open↔shut 的差异蒙版。** 它知道两只眼各在哪。

    **② 色调整平**：源图那块皮肤比目标脸暗一点，直接混就是「眼周发灰的补丁」。
    比值从蒙版环带上仍是皮肤的像素求出（亮度 >185，排除浸到刘海的部分）。

    **③ 睫毛线单独再印一遍**（混完会变淡），按亮度软过渡，硬阈值会断成虚线。

    shut 走的是另一条路（build_closed_eyes）：shut 的左眼闭眼在源画里就偏低，
    要先填眼窝再上移贴 —— 见那个函数的注释。
    """
    if src_key == "shut":
        return build_closed_eyes(C)
    OPEN, SRC, HIPS = C["open"], C[src_key], C["hips"]
    wimg = Image.fromarray((eye_weight(OPEN, SRC, lo=EYE_LO, hi=EYE_HI) * 255).astype(np.uint8), "L")
    moved = Image.new("RGBA", HIPS.size, (0, 0, 0, 0))
    masks = []
    for half in ("L", "R"):
        masks.append(np.asarray(warp_eye(wimg, half, fill=0)).astype(np.float32) / 255.0)
        moved.alpha_composite(warp_eye(SRC, half))
    m = np.maximum(masks[0], masks[1])
    # **几何闸门**：差异图只在两只眼睛的椭圆里算数。
    # eye_weight() 求的是「两张图的差异」—— 只要 src_key 不是同一个姿势的另一种表情，
    # 差异图就会整片饱和（实测 eye_weight(open, wink) 覆盖 53.5% 的身体，等于把那张画
    # 在 hips 的剪影里又铺了一遍：脸是两张脸叠的，边上多出一圈对不上的描边）。
    m *= eye_gate(HIPS.size, HIPS_EYES)

    b = np.asarray(HIPS).astype(np.float32)
    blum = 0.299 * b[:, :, 0] + 0.587 * b[:, :, 1] + 0.114 * b[:, :, 2]

    # ② 色调整平 + 混合
    o = np.asarray(moved).astype(np.float32)
    oa = o[:, :, 3:4] / 255.0
    o_rgb = o[:, :, :3] * oa + b[:, :, :3] * (1.0 - oa)
    ring = (m > 0.15) & (m < 0.60) & (blum > 185)
    if ring.sum() > 200:
        gain = (b[:, :, :3][ring].mean(axis=0) + 1e-3) / (o_rgb[ring].mean(axis=0) + 1e-3)
        gain = np.clip(gain, 0.80, 1.25)
        o_rgb = np.clip(o_rgb * gain, 0, 255)
    w = np.clip(m * 1.25, 0.0, 1.0)[:, :, None]
    rgb = b[:, :, :3] * (1 - w) + o_rgb * w

    # ③ 睫毛线
    olum = 0.299 * o_rgb[:, :, 0] + 0.587 * o_rgb[:, :, 1] + 0.114 * o_rgb[:, :, 2]
    ink = np.clip((LID_LUM - olum) / 45.0, 0.0, 1.0) * (m > 0.10) * (o[:, :, 3] > 90)
    ink = ink[:, :, None]
    rgb = rgb * (1 - ink) + o_rgb * ink
    return clean_face(Image.fromarray(np.dstack([rgb, b[:, :, 3]]).clip(0, 255).astype(np.uint8), "RGBA"), HIPS_EYES)


# ---------------- 变换 ----------------

def tint(im, color, amount):
    if amount <= 0:
        return im
    a = np.asarray(im).astype(np.float32)
    a[:, :, :3] = a[:, :, :3] * (1 - amount) + np.array(color, dtype=np.float32) * amount
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")


def dim(im, factor):
    if factor >= 1:
        return im
    a = np.asarray(im).astype(np.float32)
    a[:, :, :3] *= factor
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")


def glow(im, amount, color=GLOW_C):
    if amount <= 0:
        return im
    alpha = im.getchannel("A").filter(ImageFilter.GaussianBlur(14))
    halo = Image.new("RGBA", im.size, color + (0,))
    halo.putalpha(alpha.point(lambda v: int(v * amount)))
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.alpha_composite(halo)
    out.alpha_composite(im)
    return out


def blend_at(dst, src, x, y):
    """把 src 贴到 dst 的 (x, y)，允许坐标越界（越界部分裁掉）。"""
    x, y = int(round(x)), int(round(y))
    sx0, sy0 = max(0, -x), max(0, -y)
    dx0, dy0 = max(0, x), max(0, y)
    w = min(src.width - sx0, dst.width - dx0)
    h = min(src.height - sy0, dst.height - dy0)
    if w <= 0 or h <= 0:
        return
    dst.alpha_composite(src.crop((sx0, sy0, sx0 + w, sy0 + h)), (dx0, dy0))


def render(base, bottom, scale=1.0, squeeze_y=1.0, squeeze_x=1.0, rot=0.0,
           dx=0, dy=0, tint_color=None, tint_amount=0.0, dim_factor=1.0, glow_amount=0.0):
    """把公共空间里的一张姿势图变换后放进画布。

    bottom —— 该姿势下沿在公共空间里的行号；挤压/缩放**以它为锚**，所以「蹲下」是
    往下压而不是整体缩小、下沿不动。
    """
    sx = K * scale * squeeze_x
    sy = K * scale * squeeze_y
    w, h = max(1, round(base.width * sx)), max(1, round(base.height * sy))
    im = base.resize((w, h), Image.LANCZOS)
    if tint_color:
        im = tint(im, tint_color, tint_amount)
    im = dim(im, dim_factor)
    im = glow(im, glow_amount)

    # 公共空间点 (px,py) 在缩放后的图里位于 (px*sx, py*sy)；目标落在画布
    # (OX + px*K, OY + py*K)。旋转绕锚点做，再把锚点平移到目标位。
    px, py = ANCHOR_X * sx, bottom * sy
    tx = OX + ANCHOR_X * K + dx
    ty = OY + bottom * K + dy
    if rot:
        im = im.rotate(rot, resample=Image.BICUBIC, center=(px, py),
                       translate=(tx - px, ty - py), fillcolor=(0, 0, 0, 0))
        x, y = 0, 0
    else:
        x, y = tx - px, ty - py
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    blend_at(canvas, im, x, y)
    return canvas


# ---------------- 各动作的帧定义 ----------------

def build_frames():
    C = load_common()
    calibrate_eyes(C)
    # 主体模板的脸先净化 —— 必须在 calibrate_eyes 之后（脸区靠瞳孔定标）。
    # 只洗 hips：open/shut 只贡献**眼睛那块像素**，它们自己的脸不会上屏；
    # 合成表情时 build_expression() 会在末尾再对整张脸洗一次。
    C["hips"] = clean_face(C["hips"], HIPS_EYES, calibrate_skin=True)
    HIPS = C["hips"]
    BOT = content_bottom(HIPS)      # 所有动作共用同一个下沿锚（主体只有一张）
    print("  主体模板 hips 半身：内容底 y=%d（公共空间高 %d）" % (BOT, COMMON[1]))

    # 表情：睁眼就是主体本身，闭眼/眯眼是把另两张的**眼睛那块像素**搬过来
    E = {
        "open": HIPS,
        "shut": build_expression(C, "shut"),
    }
    w = eye_weight(C["open"], C["shut"], lo=EYE_LO, hi=EYE_HI)
    wm = np.maximum(np.asarray(warp_eye(Image.fromarray((w * 255).astype(np.uint8), "L"), "L", fill=0)),
                    np.asarray(warp_eye(Image.fromarray((w * 255).astype(np.uint8), "L"), "R", fill=0)))
    n_eye = int((wm > 12).sum())
    print("  眼部蒙版（映到 hips 后）%d px" % n_eye)

    def R(expr, **kw):
        return render(E[expr], BOT, **kw)

    # ---- 开心（双击）的滞空帧：hips 主体 + **只闭角色左眼** ----
    # 起先整张搬 wink（眯眼 · 剪刀手那张原画），后来改成「hips 打底 + 嫁接 wink 的
    # 比耶左臂」。两条路都会在桌面上留下**第二个人的线**：wink 是另一套构图，
    # 整张搬时差异蒙版饱和到 53.5% 的身体（脸是两张脸叠的），只嫁接手臂时那个窗口里
    # 88% 的像素也不是手（头发、荷叶边、袖口一起搬）。详见文件头 ⑥。
    # 现在**一格 wink 像素都不用**：眨的那只眼从 shut 那张算（blink 用的同一套闭眼），
    # 其余每一格像素都和别的帧同源。
    E["wink"] = build_closed_eyes(C, half="R")
    print("  滞空帧：hips 主体 + 只闭角色左眼（从 shut 素材搬）")

    frames = {}

    # 待机：呼吸。挤压以底边为基准 → 头顶轻微起伏，裙摆不动
    frames["idle"] = [R("open", squeeze_y=s, rot=r)
                      for s, r in [(1.000, 0.0), (1.004, 0.4), (1.008, 0.7), (1.010, 0.8),
                                   (1.008, 0.6), (1.004, 0.3), (1.000, 0.0), (0.997, -0.3)]]

    # 眨眼：睁 → 闭 → 睁，三段硬切（2D 动画里的眨眼本来就是硬切）。
    #
    # 原来有「半闭」的中间帧，做法是 open*0.45 + shut*0.55 —— **睁眼的虹膜和闭眼的
    # 睫毛线叠成了重影**，桌面上就是用户说的「脸上有一堆意义不明的线」。
    # 试过改成「眼皮下落」（把闭眼的睫毛线以上盖过来）：但闭眼那张的睫毛线本来就画在
    # 眼睛偏下的位置，压下来也压不到一半，看上去和全闭没区别，白多一帧。
    # 所以砍掉中间帧，改成**把闭这一帧停久一点**（main.js 里的 ms = [56, 140, 56]，
    # 全程 252ms）—— 一个干净的闭眼，比两帧糊的强。
    frames["blink"] = [R("open", squeeze_y=1.004), R("shut"), R("open", squeeze_y=1.004)]

    # 小动作：自己晃一下（左倾再回正），末帧接近中立，切回待机不突兀
    frames["acting"] = [R("open", rot=r, dy=d, squeeze_y=s)
                        for r, d, s in [(0.0, 0, 1.000), (-1.8, -2, 1.004), (-2.8, -4, 1.006),
                                        (-2.0, -3, 1.004), (-0.8, -1, 1.002), (0.9, 1, 1.000),
                                        (0.5, 0, 0.999), (0.0, 0, 1.000)]]

    # 「原地晃晃」：主体本来就是叉腰站姿，这个动作**不再换姿势**（原来那张 open 的
    # 剪刀手起势帧已经不需要了 —— 换了模板之后它反而是「换姿势」）。改成幅度大一点的
    # 站稳-晃-归位，和 idle 的细微呼吸区分开。
    frames["hips"] = [R("open", squeeze_y=s, squeeze_x=x, dy=d, rot=r)
                      for s, x, d, r in [(0.978, 1.016, 4, -1.4), (1.008, 0.994, -3, 1.0),
                                         (1.018, 0.990, -5, 1.5), (1.010, 0.993, -3, 0.8),
                                         (0.996, 1.000, 1, -0.3), (0.990, 1.006, 2, -0.6),
                                         (0.998, 1.002, 0, -0.2), (1.000, 1.000, 0, 0.0)]]

    # 开心（双击）：起势 → 蹲 → 滞空（这时眨角色左眼）→ 落地 → 回正
    # 首帧必须是**中立姿态**：双击是从待机的任意一帧切过来的，若第一帧就是「蹲」，
    # 那一下错位很明显（用户说的「切换动作僵硬」）。给一帧起势，蹲才像是主动做的。
    frames["happy"] = [R("open"),
                       R("open", squeeze_y=0.975, squeeze_x=1.015),
                       R("wink", dy=-26),
                       R("open", squeeze_y=0.965, squeeze_x=1.022, dy=1),
                       R("open", squeeze_y=1.005, dy=-2)]

    # 受击：左右抖动；普通痛与暴击再叠一层泛红
    frames["pain-weak"] = [R("open", dx=dx, dy=dy, rot=r, squeeze_y=s)
                           for dx, dy, r, s in [(0, 0, 0.0, 1.000), (-4, 3, -1.2, 0.986),
                                                (3, 2, 1.0, 0.991), (-3, 3, -0.8, 0.988),
                                                (2, 1, 0.5, 0.995), (0, 0, 0.0, 1.000)]]
    frames["pain-normal"] = [R("open", dx=dx, dy=dy, rot=r, squeeze_y=s,
                               tint_color=RED, tint_amount=t)
                             for dx, dy, r, s, t in [(0, 0, 0.0, 1.000, 0.0), (-6, 6, -1.8, 0.972, 0.10),
                                                     (5, 4, 1.5, 0.982, 0.07), (-5, 5, -1.4, 0.976, 0.05),
                                                     (3, 2, 0.8, 0.990, 0.03), (0, 0, 0.0, 1.000, 0.0)]]

    # 暴击：抖得最狠 + 泛红。首帧刻意就不是中立姿态 —— 否则事件到达后 260ms 毫无变化，
    # 抓帧对比起来就像「动画根本没播」。
    frames["critical"] = [R("open", dx=dx, dy=dy, rot=r, squeeze_y=s, tint_color=RED, tint_amount=t)
                          for dx, dy, r, s, t in [(-4, 5, -1.0, 0.975, 0.12), (-7, 9, -1.6, 0.958, 0.20),
                                                  (6, 6, 1.4, 0.972, 0.15), (-6, 7, -1.2, 0.962, 0.11),
                                                  (4, 3, 0.7, 0.985, 0.06), (0, 0, 0.0, 1.000, 0.0)]]

    # 复苏：从瘫软一路亮起来
    frames["revive"] = [R("open", squeeze_y=0.92, squeeze_x=1.025, dy=8, dim_factor=0.68,
                          tint_color=RED, tint_amount=0.10),
                        R("open", squeeze_y=0.95, squeeze_x=1.016, dy=4, dim_factor=0.82, glow_amount=0.20),
                        R("open", squeeze_y=0.99, dy=-2, dim_factor=0.92, glow_amount=0.30),
                        R("open", scale=1.02, dy=-6, glow_amount=0.26),
                        R("open", dy=0, glow_amount=0.14),
                        R("open", squeeze_y=0.995, dy=1, glow_amount=0.06),
                        R("open", dy=-8, squeeze_y=1.004),
                        # 收势：腾起之后落回中立。不加这一帧的话，末帧停在「往上飘 8px」
                        # 的状态，切回待机会整个掉下来一下。
                        R("open")]

    states = {
        "critical-combo": R("open", squeeze_y=0.93, squeeze_x=1.022, rot=-1.2, dy=4,
                            dim_factor=0.84, tint_color=RED, tint_amount=0.12),
    }
    return frames, states, frames["idle"][0]


# ---------------- 落盘 ----------------

CLIP_WARN = 16
_clipped = []


def save(im, *rel):
    a = np.asarray(im)[:, :, 3]
    edges = {"上": int(a[0, :].max()), "下": int(a[-1, :].max()),
             "左": int(a[:, 0].max()), "右": int(a[:, -1].max())}
    bad = {k: v for k, v in edges.items() if v > CLIP_WARN}
    if bad:
        _clipped.append(("/".join(rel), bad))
    p = os.path.join(ASSET, *rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    im.save(p, optimize=True)
    return p


def prune(written):
    """删掉**这一轮没写出**的旧帧。

    动作帧数是会变的（这一版就把 hips 从 10 帧收到 8 帧）。不删的话 hips-09/10 会
    留在目录里，而渲染端的帧数是 main.js 里写死的 —— 多出来的文件不会被加载，只会
    在「数一下 frames/ 有几张」时骗人。这里以本轮产出为准，多的就删。
    """
    keep = {os.path.normcase(os.path.abspath(p)) for p in written}
    gone = []
    fdir = os.path.join(ASSET, "frames")
    for name in sorted(os.listdir(fdir)):
        if not name.endswith(".png"):
            continue
        p = os.path.join(fdir, name)
        if os.path.normcase(os.path.abspath(p)) not in keep:
            os.remove(p)
            gone.append(name)
    return gone


if __name__ == "__main__":
    print("=== 合成傻鱼动作帧 ===")
    frames, states, tray = build_frames()

    written = []
    for name, ims in frames.items():
        for i, im in enumerate(ims, 1):
            written.append(save(im, "frames", "%s-%02d.png" % (name, i)))
    for name, im in states.items():
        written.append(save(im, "states", name + ".png"))
    written.append(save(tray, "idle.png"))

    gone = prune(written)
    if gone:
        print("清掉 %d 张上一版遗留的帧：%s" % (len(gone), ", ".join(gone)))

    print("写出 %d 帧，共 %.1f KB" % (len(written), sum(os.path.getsize(p) for p in written) / 1024))
    if _clipped:
        print("!! 有帧被画布裁到（要收幅度或加留白）:")
        for rel, bad in _clipped:
            print("   %-40s %s" % (rel, bad))
    else:
        print("裁切自检：%d 帧全部完整，没有内容贴到画布边缘" % len(written))

    # 接触印相表
    order = ["idle", "blink", "acting", "hips", "happy", "pain-weak", "pain-normal", "critical", "revive"]
    cols = max(len(frames[k]) for k in order)
    cell = 96
    sheet = Image.new("RGB", (cols * cell + 96, len(order) * (cell + 16) + 10), (24, 28, 40))
    d = ImageDraw.Draw(sheet)
    for r, name in enumerate(order):
        y = 8 + r * (cell + 16)
        d.text((6, y + cell // 2), name, fill=(255, 220, 120))
        for c, im in enumerate(frames[name]):
            th = im.resize((cell, int(im.height * cell / im.width)), Image.LANCZOS)
            sheet.paste(th.convert("RGB"), (96 + c * cell, y), th.split()[3].point(lambda v: int(v * 0.85)))
    sheet.save(os.path.join(TOOLS, "_qa-frames.png"))
    print("质检图 tools/_qa-frames.png", sheet.size)
