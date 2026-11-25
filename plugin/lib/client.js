// AI Knowledge Navigator —— DSH 插件（浏览器半，ModuleLoader 格式）
//
// 在 DSH 界面右下角注入一颗「与 RTL_Cockpit 同款」的椭圆按钮，叠在它上方 10px：
//   RTL_Cockpit: bottom 18px, 高 38px  →  本按钮: bottom 66px（18 + 38 + 10）
// 几何、圆角、字重、阴影、透明度、hover 位移全部与 RTLCockpit 保持一致，
// 只换图标/文案/渐变主色，便于一眼区分「两颗同类按钮」。
//
// 交互也保持一致：普通点击在当前标签进入 /akn/；Ctrl/Cmd/Shift/中键在新标签打开。
// 不依赖宿主内部 API，不读任何密钥（模型调用在宿主进程内完成）。
//
// 注意：factory 必须返回合法 cordis 插件形态（函数或带 apply 的对象）。
// 返回 undefined 会导致整个前端引导失败（这是 RTLCockpit 踩过的坑）。

window.__ModuleLoader__.load({
  id: 'akn',
  factory: function () {
    var exports = { name: 'akn' }

    exports.apply = function apply(ctx) {
      // 幂等：HMR 重放或重复 apply 时不重复挂按钮
      if (document.getElementById('akn-launcher-host')) return

      var host = document.createElement('div')
      host.id = 'akn-launcher-host'
      var shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host

      var style = document.createElement('style')
      style.textContent = [
        '.fab {',
        '  position: fixed; right: 18px; bottom: 66px; z-index: 2147483647;',
        '  display: inline-flex; align-items: center; gap: 7px;',
        '  height: 38px; padding: 0 15px 0 12px;',
        '  border-radius: 20px; border: 1px solid rgba(255,255,255,.18);',
        '  background: linear-gradient(135deg,#2f6bd8,#1f9d7a);',
        '  color: #fff; font-size: 13px; font-weight: 600;',
        '  font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
        '  text-decoration: none; cursor: pointer; user-select: none;',
        '  box-shadow: 0 4px 16px rgba(40,60,120,.35);',
        '  transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease;',
        '  opacity: .92;',
        '}',
        '.fab:hover { transform: translateY(-1px); opacity: 1;',
        '  box-shadow: 0 7px 22px rgba(40,60,120,.45); }',
        '.fab:active { transform: translateY(0); }',
        '.ico { font-size: 16px; line-height: 1; }',
      ].join('\n')

      var link = document.createElement('a')
      link.className = 'fab'
      link.href = '/akn/'
      link.title = '打开 PDF 学习（AI Knowledge Navigator：PDF → 知识图谱）'
      link.setAttribute('aria-label', '打开 PDF 学习')
      link.innerHTML = '<span class="ico">📚</span><span>PDF 学习</span>'

      // 与 RTLCockpit 一致的点击语义：普通点击就地进入，修饰键/中键走浏览器默认（新标签）
      link.addEventListener('click', function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        window.location.assign('/akn/')
      })

      shadow.appendChild(style)
      shadow.appendChild(link)

      function mount() {
        if (!host.parentNode) document.body.appendChild(host)
      }
      if (document.body) mount()
      else document.addEventListener('DOMContentLoaded', mount, { once: true })

      // HMR 卸载本插件时移除按钮，避免重载后重复
      if (ctx && typeof ctx.on === 'function') {
        ctx.on('dispose', function () {
          if (host.parentNode) host.parentNode.removeChild(host)
        })
      }
    }

    return exports
  },
})
