'use strict'

window.UI = (() => {
  const root = () => document.getElementById('modal-root')
  const toastRoot = () => document.getElementById('toasts')

  const openModals = new Set()

  function el (tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function modal (options = {}) {
    const backdrop = el('div', 'modal-backdrop')
    const dialog = el('div', `modal${options.wide ? ' is-wide' : ''}`)

    const head = el('div', 'modal-head')
    const headMain = el('div', 'modal-head-main')
    headMain.appendChild(el('h2', 'modal-title', options.title || ''))
    if (options.subtitle) {
      const sub = el('div', 'modal-sub', options.subtitle)
      if (options.subtitleNoBrand) sub.dataset.noBrand = ''
      headMain.appendChild(sub)
    }
    head.appendChild(headMain)

    const closeBtn = el('button', 'modal-close', '✕')
    closeBtn.type = 'button'
    head.appendChild(closeBtn)
    dialog.appendChild(head)

    const body = el('div', 'modal-body')
    if (options.body) body.appendChild(options.body)
    dialog.appendChild(body)

    let foot = null
    const refs = {}
    if (Array.isArray(options.actions) && options.actions.length) {
      foot = el('div', 'modal-foot')
      for (const action of options.actions) {
        const button = el('button', `btn ${action.className || 'btn-ghost'}`, action.label)
        button.type = 'button'
        if (action.disabled) button.disabled = true
        button.addEventListener('click', () => {
          if (typeof action.onClick === 'function') action.onClick(controller)
        })
        if (action.ref) refs[action.ref] = button
        foot.appendChild(button)
      }
      dialog.appendChild(foot)
    }

    backdrop.appendChild(dialog)
    root().appendChild(backdrop)
    openModals.add(backdrop)

    function close () {
      if (!openModals.has(backdrop)) return
      openModals.delete(backdrop)
      backdrop.remove()
      document.removeEventListener('keydown', onKey)
      if (typeof options.onClose === 'function') options.onClose()
    }

    function onKey (event) {
      if (event.key === 'Escape') close()
    }

    closeBtn.addEventListener('click', close)
    backdrop.addEventListener('mousedown', event => {
      if (event.target === backdrop && options.dismissable !== false) close()
    })
    document.addEventListener('keydown', onKey)

    const controller = { close, dialog, body, backdrop, setBusy, foot, headMain }
    Object.assign(controller, refs)
    return controller
  }

  function setBusy (controller, busy) {
    if (!controller || !controller.foot) return
    for (const button of controller.foot.querySelectorAll('button')) {
      button.disabled = busy
    }
  }

  function confirm (options = {}) {
    return new Promise(resolve => {
      let resolved = false
      const controller = modal({
        title: options.title || 'Подтверждение',
        subtitle: options.subtitle,
        body: options.body || el('div', 'muted', options.text || ''),
        actions: [
          {
            label: options.cancelLabel || 'ОТМЕНА',
            onClick: () => { resolved = true; controller.close(); resolve(false) }
          },
          {
            label: options.confirmLabel || 'ПОДТВЕРДИТЬ',
            className: options.confirmClassName || 'btn-primary',
            onClick: () => { resolved = true; controller.close(); resolve(true) }
          }
        ],
        onClose: () => { if (!resolved) resolve(false) }
      })
    })
  }

  function toast (options = {}) {
    const node = el('div', `toast${options.type ? ` is-${options.type}` : ''}`)
    if (options.title) node.appendChild(el('div', 'toast-title', options.title))
    if (options.text) node.appendChild(el('div', 'toast-text', options.text))
    toastRoot().appendChild(node)
    setTimeout(() => {
      node.style.transition = 'opacity .3s, transform .3s'
      node.style.opacity = '0'
      node.style.transform = 'translateX(-16px)'
      setTimeout(() => node.remove(), 320)
    }, options.duration || 5200)
    return node
  }

  return { modal, confirm, toast, setBusy, el }
})()
