import { getPlatform, isVerificationUrl, type PlatformId } from "@shared/platforms";

export interface HomepageLoginVerdict {
  kind: "online" | "offline" | "unconfirmed";
  reason: string;
  source: "homepage";
  /** Current-account avatar source only; the main process must validate/cache it before display. */
  avatarUrl?: string;
}

const PUBLIC_HOSTS: Partial<Record<PlatformId, string>> = {
  douyin: "www.douyin.com",
  kuaishou: "www.kuaishou.com",
  xiaohongshu: "www.xiaohongshu.com",
  bilibili: "www.bilibili.com",
};

/** Public-site checks must never consume a creator console's authentication state. */
export function isHomepageContext(platformId: PlatformId, url: string): boolean {
  try {
    const page = new URL(url);
    return Boolean(
      PUBLIC_HOSTS[platformId] &&
      page.protocol === "https:" &&
      !page.username &&
      !page.password &&
      !page.port &&
      page.hostname === PUBLIC_HOSTS[platformId] &&
      !isVerificationUrl(platformId, url),
    );
  } catch {
    return false;
  }
}

/**
 * Read only the public site's current-account UI and dedicated account stores.
 * No requests, cookie reads, DOM mutations, or global-object traversal.
 * Only the confirmed account's avatar may be returned; names/IDs stay in-page.
 * Recommendation authors and a generic "我的" link prove nothing.
 */
export function buildHomepageLoginScript(platformId: PlatformId): string {
  const { verificationHosts, verificationPaths } = getPlatform(platformId).login;
  return `(() => {
    const platform = ${JSON.stringify(platformId)};
    const host = ${JSON.stringify(PUBLIC_HOSTS[platformId] ?? "")};
    const verificationHosts = ${JSON.stringify(verificationHosts)};
    const verificationPaths = ${JSON.stringify(verificationPaths)};
    const result = (kind, reason, avatarUrl) => ({ kind, reason, source: 'homepage',
      ...(kind === 'online' && avatarUrl ? { avatarUrl } : {}) });
    const unknown = () => result('unconfirmed', '主页登录信息尚未加载或未能识别，保留上次状态');
    try {
      const page = new URL(location.href);
      // Mirror shared isVerificationUrl using the same platform registry. A
      // challenge may be nested (e.g. /web-login/captcha or /login/geetest).
      const normalizedHost = page.hostname.toLowerCase().replace(/\\.$/, '');
      const isVerification = verificationHosts.some(value => {
        const root = value.toLowerCase().replace(/^\\./, '').replace(/\\.$/, '');
        return normalizedHost === root || normalizedHost.endsWith('.' + root);
      }) || verificationPaths.some(value => page.pathname.toLowerCase().includes(value.toLowerCase()));
      if (!host || page.protocol !== 'https:' || page.hostname !== host ||
          page.port || page.username || page.password ||
          isVerification) return unknown();

      const read = (root, path) => {
        let value = root;
        for (const name of path) {
          if (!value || typeof value !== 'object') return undefined;
          value = value[name];
          if (value && typeof value === 'object' && value.__v_isRef === true)
            value = value.value === undefined ? value._value : value.value;
        }
        return value;
      };
      const hasId = (user) => user && typeof user === 'object' &&
        ['userId', 'user_id', 'uid', 'id', 'mid', 'secUid', 'sec_uid', 'eid'].some(key => {
          const value = user[key];
          return typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 :
            typeof value === 'string' && value.trim() !== '' &&
              !/^(?:0|-1|null|undefined|guest|anonymous)$/i.test(value.trim());
        });
      const visible = (node) => {
        if (!node || !node.isConnected) return false;
        for (let current = node; current; current = current.parentElement) {
          if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        }
        return true;
      };
      const elements = (selectors) => Array.from(document.querySelectorAll(selectors)).filter(node =>
        visible(node) && !node.closest('main, article, [data-e2e="feed-active-video"], [data-e2e="feed-video"], .note-item, .video-card'));
      const text = node => (node.textContent || '').trim().replace(/\\s+/g, '');
      const image = root => Array.from(root.querySelectorAll('img')).some(img => visible(img) &&
        Boolean(img.getAttribute('src')) && !/(?:default[-_]?avatar|noface|not[-_]?login)/i.test(img.getAttribute('src')));
      const safeAvatarUrl = value => {
        if (typeof value !== 'string' || !value.trim() || value.length > 4096 ||
            /(?:default[-_]?avatar|noface|not[-_]?login)/i.test(value)) return undefined;
        try {
          const url = new URL(value, location.href);
          if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
          return url.href;
        } catch { return undefined; }
      };
      const accountLinks = (root, pattern, expectedHost) => {
        const links = root.matches('a[href]') ? [root] : Array.from(root.querySelectorAll('a[href]'));
        return links.filter(link => {
          try {
            const url = new URL(link.getAttribute('href'), location.href);
            return visible(link) && url.protocol === 'https:' && url.hostname === expectedHost &&
              !url.username && !url.password && !url.port && pattern.test(url.pathname);
          } catch { return false; }
        });
      };
      const profileLink = (root, pattern, expectedHost) => accountLinks(root, pattern, expectedHost).length > 0;
      // Read bounded, predefined avatar fields only. Never recursively search
      // account data or recommendation JSON for something that looks like an image.
      const storeAvatar = user => {
        try {
        const fields = platform === 'douyin' ? ['avatar_thumb', 'avatar_medium', 'avatar_larger', 'avatar', 'avatar_url'] :
          platform === 'xiaohongshu' ? ['userAvatar', 'avatar', 'imageb', 'images', 'image'] :
          platform === 'kuaishou' ? ['headUrl', 'headurl', 'avatar', 'headUrls', 'userHead'] : [];
        for (const key of fields) {
          const value = read(user, [key]);
          const candidates = typeof value === 'string' ? [value] : Array.isArray(value) ? value.slice(0, 8) :
            value && typeof value === 'object' ? [value.url, ...(Array.isArray(value.url_list) ? value.url_list.slice(0, 8) : [])] : [];
          for (const candidate of candidates) {
            const url = safeAvatarUrl(typeof candidate === 'string' ? candidate : read(candidate, ['url']));
            if (url) return url;
          }
        }
          return undefined;
        } catch { return undefined; }
      };

      // These paths describe the *current* account. Do not add generic userInfo
      // or profile objects: those often belong to the author being viewed.
      const stores = platform === 'xiaohongshu' ? [
        read(window, ['__INITIAL_STATE__', 'user']),
        read(document.querySelector('#app'), ['__vue_app__', 'config', 'globalProperties', '$pinia', 'state', 'user']),
      ] : platform === 'kuaishou' ? [
        read(window, ['__NUXT__', 'state', 'user']),
        read(window, ['__INITIAL_STATE__', 'loginUser']),
      ] : platform === 'douyin' ? [
        read(window, ['__INITIAL_STATE__', 'userStore']),
        read(window, ['__INITIAL_STATE__', 'currentUserStore']),
      ] : [];
      let storeLoggedIn = false;
      let storeLoggedOut = false;
      const storeAvatars = new Set();
      for (const store of stores) {
        if (!store || typeof store !== 'object') continue;
        const loggedIn = read(store, ['loggedIn']) ?? read(store, ['isLogin']) ?? read(store, ['isLoggedIn']);
        const user = read(store, ['userInfo']) ?? read(store, ['currentUser']) ?? read(store, ['user']);
        if (loggedIn === true && hasId(user)) {
          storeLoggedIn = true;
          const avatar = storeAvatar(user);
          if (avatar) storeAvatars.add(avatar);
        }
        if (loggedIn === false) storeLoggedOut = true;
      }

      // Dedicated signed-in account controls; an avatar elsewhere is not evidence.
      const accountRoots = {
        douyin: '[data-e2e="douyin-header"] [data-e2e="user-info"], header [data-e2e="user-info"], header [data-e2e="user-avatar"], [data-e2e="douyin-header"] [data-e2e="user-avatar"]',
        xiaohongshu: '.side-bar .user.side-bar-component, .side-bar .user, .side-bar-component.user',
        kuaishou: 'header .user-info, .header .user-info, .header-user-info, .header-user, .header-user-avatar',
        bilibili: '.bili-header .header-avatar-wrap, #bili-header-container .header-avatar-wrap, .bili-mini-header .header-avatar-wrap',
      };
      const profilePatterns = {
        douyin: /^\\/user\\/(?!self(?:\\/|$))[^/]+\\/?$/,
        xiaohongshu: /^\\/user\\/profile\\/[^/]+\\/?$/,
        kuaishou: /^\\/(?:profile|user)\\/[^/]+\\/?$/,
        bilibili: /^\\/[1-9]\\d*\\/?$/,
      };
      const profileHost = platform === 'bilibili' ? 'space.bilibili.com' : host;
      const currentAccountRoots = elements(accountRoots[platform]);
      let accountAvatar = currentAccountRoots.some(root =>
        image(root) && profileLink(root, profilePatterns[platform], profileHost));
      const domAvatars = new Set();
      for (const root of currentAccountRoots) {
        for (const link of accountLinks(root, profilePatterns[platform], profileHost)) {
          for (const img of Array.from(link.querySelectorAll('img'))) {
            if (!visible(img)) continue;
            const avatar = safeAvatarUrl(img.currentSrc || img.getAttribute('src'));
            if (avatar) domAvatars.add(avatar);
          }
        }
      }
      // The current Kuaishou homepage uses a clickable sidebar div, not a
      // header profile link. Match the rendered account against the one fixed
      // self-profile response slot; never inspect feed/profile-author entries.
      if (platform === 'kuaishou' && document.readyState !== 'loading') {
        const self = read(window, ['INIT_STATE', 'tusjoh.0sftu0w0qspgjmf0hfu-pckfdu.']);
        if (self?.result === 1 && hasId(self) && typeof self.userName === 'string' && self.userName.trim()) {
          const expectedAvatar = safeAvatarUrl(self.userHead);
          // Kuaishou wraps both navigation and feed in <main>; scope directly
          // to its left navigation instead of the generic feed exclusion.
          const roots = Array.from(document.querySelectorAll('.workbench > main > .wb-left > .sidebar > .down > .down-box.login > .user.item'))
            .filter(node => visible(node) && !node.closest('article, .video-card, .note-item'));
          for (const root of roots) {
            const label = root.querySelector(':scope > .text');
            const img = root.querySelector(':scope > img.image');
            const avatar = img && visible(img) && safeAvatarUrl(img.currentSrc || img.getAttribute('src'));
            if (label && label.textContent.trim() === self.userName.trim() &&
                expectedAvatar && avatar === expectedAvatar) {
              accountAvatar = true;
              domAvatars.add(avatar);
            }
          }
        }
      }
      // Conflicting account images can appear during account switching; wait
      // for a single current avatar rather than caching one at random.
      const currentAvatarUrl = domAvatars.size === 1 ? Array.from(domAvatars)[0] : undefined;

      const controls = elements('header button, header a, header [role="button"], header [role="menuitem"], ' +
        '.side-bar button, .side-bar a, .side-bar [role="button"], .user-menu button, .user-menu a, ' +
        '[role="menu"] [role="menuitem"], .header-avatar-wrap .logout, .header-avatar-wrap .logout-item');
      const logoutEntry = controls.some(node => /^(?:退出登录|退出登陆|登出|Logout|Signout)$/i.test(text(node)));

      // A store's false value can be its initial hydration default. Wait for a
      // rendered, explicit login entry before concluding that it is signed out.
      const loginSelectors = {
        douyin: '[data-e2e="douyin-header"] [data-e2e="login-button"], header [data-e2e="login-button"], header button, header [role="button"]',
        xiaohongshu: '.side-bar .login-btn, .side-bar button, .side-bar-component.login, .login-container .login-btn',
        kuaishou: 'header .login-button, header .login-btn, .header .login-button, .header .login-btn, .header-login',
        bilibili: '.bili-header .header-login-entry, #bili-header-container .header-login-entry, .bili-mini-header .header-login-entry',
      };
      const loginEntry = elements(loginSelectors[platform]).some(node => /^(?:登录|登录注册|登录\\/注册|立即登录|去登录|登录体验更多|Login|Signin)$/i.test(text(node)));
      // A persisted SSR store can still claim login after a real logout. A
      // rendered login entry takes precedence; conflicting live controls or
      // a partially rendered transition cannot confirm either state.
      if (loginEntry) {
        if (document.readyState === 'loading' || accountAvatar || logoutEntry) return unknown();
        return result('offline', storeLoggedOut ? '主页当前账号状态为未登录' : '主页已显示未登录入口');
      }
      if (accountAvatar) return result('online', '主页已显示当前登录账号', currentAvatarUrl);
      if (logoutEntry) return result('online', '主页已显示已登录账号的退出入口');
      if (storeLoggedIn && !storeLoggedOut) return result('online', '主页当前账号已登录',
        storeAvatars.size === 1 ? Array.from(storeAvatars)[0] : undefined);
      return unknown();
    } catch { return unknown(); }
  })()`;
}
