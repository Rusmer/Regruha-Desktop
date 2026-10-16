'use strict'

window.Format = (() => {
  const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']

  function bytes (value, digits = 1) {
    let num = Number(value) || 0
    if (num < 1) return '0 Б'
    let index = 0
    while (num >= 1024 && index < UNITS.length - 1) {
      num /= 1024
      index += 1
    }
    const places = num >= 100 || index === 0 ? 0 : digits
    return `${num.toFixed(places)} ${UNITS[index]}`
  }

  function speed (value) {
    return `${bytes(value, 1)}/с`
  }

  function percent (value, digits = 1) {
    const num = Math.max(0, Math.min(1, Number(value) || 0)) * 100
    if (num >= 100) return '100%'
    return `${num.toFixed(digits)}%`
  }

  function eta (seconds) {
    const total = Number(seconds)
    if (!total || !Number.isFinite(total) || total <= 0 || total > 86400 * 30) return '—'
    const sec = Math.floor(total % 60)
    const min = Math.floor((total / 60) % 60)
    const hours = Math.floor((total / 3600) % 24)
    const days = Math.floor(total / 86400)
    if (days > 0) return `${days} д ${hours} ч`
    if (hours > 0) return `${hours} ч ${min} мин`
    if (min > 0) return `${min} мин ${sec} с`
    return `${sec} с`
  }

  function ratio (value) {
    const num = Number(value) || 0
    if (!Number.isFinite(num)) return '∞'
    return num.toFixed(2)
  }

  function date (timestamp) {
    try {
      return new Date(timestamp).toLocaleString('ru-RU')
    } catch {
      return '—'
    }
  }

  function shortHash (hash) {
    if (!hash) return '—'
    return hash.slice(0, 8).toUpperCase()
  }

  function plural (count, one, few, many) {
    const abs = Math.abs(count) % 100
    const last = abs % 10
    if (abs > 10 && abs < 20) return many
    if (last > 1 && last < 5) return few
    if (last === 1) return one
    return many
  }

  return { bytes, speed, percent, eta, ratio, date, shortHash, plural }
})()
