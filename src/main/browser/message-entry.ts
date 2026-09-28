/** Only opens the public site's own message navigation. No message bodies or input values cross IPC. */
export function buildDouyinMessageEntryScript(): string {
  return `(() => {
    if (location.protocol !== 'https:' || location.hostname !== 'www.douyin.com' || location.port || new URL(location.href).username || new URL(location.href).password) return false;
    const visible = element => {
      if (!(element instanceof HTMLElement) || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const controls = document.querySelectorAll('header a, header button, header [role="button"], [role="banner"] a, [role="banner"] button, [role="banner"] [role="button"]');
    if (controls.length > 250) return false;
    const candidates = [...new Set(controls)].filter(element => {
      if (!visible(element) || element.closest('form,[role="dialog"]') || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return false;
      const label = (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\\s/g, '');
      if (!/^消息(?:\\d+\\+?)?$/.test(label)) return false;
      if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) {
        const target = new URL(element.href, location.href);
        if (target.protocol !== 'https:' || target.hostname !== location.hostname || target.username || target.password || target.port) return false;
      }
      return true;
    });
    if (candidates.length !== 1) return false;
    candidates[0].click();
    return true;
  })()`;
}
