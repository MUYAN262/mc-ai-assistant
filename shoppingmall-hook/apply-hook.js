// 用法： node apply-hook.js "<服务器目录>/plugins/ShoppingMall/ShoppingMall.js"
// 作用：把 sm_ai_hook.js 的内容追加到 ShoppingMall.js 末尾（幂等，装过就跳过）
const fs = require('fs')
const path = require('path')
const target = process.argv[2]
if (!target) { console.log('用法: node apply-hook.js <ShoppingMall.js 路径>'); process.exit(1) }
if (!fs.existsSync(target)) { console.log('找不到文件：' + target); process.exit(1) }
let src = fs.readFileSync(target, 'utf8')
if (src.includes('__AI_SHOP_API__')) { console.log('已经装过钩子了，不需要重复追加'); process.exit(0) }
const hook = fs.readFileSync(path.join(__dirname, 'sm_ai_hook.js'), 'utf8')
const bak = target + '.bak-aihook-' + new Date().toISOString().slice(0, 10)
fs.copyFileSync(target, bak)
fs.writeFileSync(target, src.replace(/\s*$/, '') + '\n\n' + hook, 'utf8')
console.log('已追加钩子，原件备份在：' + bak)
console.log('重启服务器后日志会出现：[ShoppingMall] [AI 接口] 已开放 sm_aiQuery / sm_aiBuy / sm_aiSell')