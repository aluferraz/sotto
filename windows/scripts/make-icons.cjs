/**
 * Draws the app and tray icons from the same shapes as the web icon:
 *   electron scripts/make-icons.cjs
 * The PNG files it writes into assets/ are committed, so this only runs when the icon changes.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const bars = (fill) => `<g fill="${fill}"><rect x="6.5" y="13" width="3" height="6" rx="1.5"/><rect x="11.5" y="9" width="3" height="14" rx="1.5"/><rect x="16.5" y="11.5" width="3" height="9" rx="1.5"/><rect x="21.5" y="7" width="3" height="18" rx="1.5"/></g>`
const icon = (background) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${background}"/>${bars('#fff')}</svg>`

const files = [
  ['icon.png', 512, icon('#6d4aff')],
  ['tray.png', 32, icon('#6d4aff')],
  ['tray-active.png', 32, icon('#e5484d')],
]

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const out = path.join(__dirname, '..', 'assets')
  fs.mkdirSync(out, { recursive: true })
  for (const [name, size, svg] of files) {
    const window = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true })
    const page = `<html><body style="margin:0;background:transparent;overflow:hidden"><div style="width:${size}px;height:${size}px">${svg}</div></body></html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    fs.writeFileSync(path.join(out, name), image.resize({ width: size, height: size }).toPNG())
    window.destroy()
    console.log('wrote', name)
  }
  app.exit(0)
})
