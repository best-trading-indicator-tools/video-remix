// Native alerts are optional. Unsigned macOS previews may reject them; retain a
// visible in-app notice and signal in the Dock/taskbar instead.
const notifications = new Set();
exports.showBatchNotification = ({ Notification, window, app, body }) => {
  if (typeof body !== 'string' || !body.length || body.length > 200) throw new Error('Invalid completion notice.');
  const fallback = () => { if (!window.isDestroyed()) window.flashFrame(true); app.dock?.bounce('informational'); return false; };
  if (!Notification.isSupported()) return Promise.resolve(fallback());
  return new Promise(resolve => {
    let done = false, timer;
    const finish = shown => { if (done) return; done = true; clearTimeout(timer); resolve(shown || fallback()); };
    const notice = new Notification({ title: 'Remix Studio · Collection finished', body });
    notifications.add(notice);
    notice.once('show', () => finish(true));
    notice.once('failed', () => { notifications.delete(notice); finish(false); });
    notice.once('close', () => notifications.delete(notice));
    notice.on('click', () => { if (window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); window.flashFrame(false); window.webContents.send('batches:open'); });
    timer = setTimeout(() => finish(false), 3000); timer.unref?.();
    setTimeout(() => notifications.delete(notice), 600_000).unref?.();
    try { notice.show(); } catch { notifications.delete(notice); finish(false); }
  });
};
