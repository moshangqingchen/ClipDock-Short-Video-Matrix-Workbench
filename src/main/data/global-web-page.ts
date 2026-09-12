import type { GlobalPlatformId } from "@shared/platforms";
import type { WebIdentity } from "@shared/global-workspace";
import { GLOBAL_PAGE_TEXT_SCRIPT } from "./global-web-observation";

export interface RawWebWork {
  remoteId: string;
  title: string;
  url: string;
  publishedAt: string | null;
  metrics: Partial<Record<"views" | "impressions" | "likes" | "comments" | "shares", string>>;
}
export interface GlobalPageRead {
  url: string;
  text: string;
  identity: WebIdentity;
  works: RawWebWork[];
}

/** Fixed, read-only extraction templates. Login inputs, editable drafts and cookies are never read. */
export function globalPageScript(platform: GlobalPlatformId): string {
  return `(() => {
    const base = ${GLOBAL_PAGE_TEXT_SCRIPT};
    const platform = ${JSON.stringify(platform)};
    const clean = value => String(value || '').replace(/\\s+/g,' ').trim();
    const text = el => !el || el.closest('input,textarea,[contenteditable=true]') ? '' : clean(el.innerText || el.textContent).slice(0,2000);
    const href = el => { if(!el) return ''; try { const u = new URL(el?.getAttribute('href') || '',location.href); return u.origin + u.pathname; } catch { return ''; } };
    let subjectId=null, name=null, status='unknown';
    if (/\\/(?:challenge|checkpoint|account\\/access|captcha)(?:\\/|$)/i.test(location.pathname)) status='needs_verification';
    else if (/accounts\\.google\\.com$/.test(location.hostname) || /\\/(?:login|i\\/flow\\/login|signin)(?:\\/|$)/i.test(location.pathname)) status='offline';
    else if(platform==='youtube') {
      const channel=/^\\/channel\\/(UC[a-zA-Z0-9_-]{22})(?:\\/|$)/.exec(location.pathname);
      if(channel && document.querySelector('ytcp-app')) { subjectId=channel[1]; status='online'; name=text(document.querySelector('#entity-name,ytcp-navigation-drawer #channel-name')); }
    } else if(platform==='x') {
      const link=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      const match=/^https:\\/\\/(?:www\\.)?x\\.com\\/([a-zA-Z0-9_]{1,15})\\/?$/.exec(href(link));
      if(match) { subjectId=match[1]; status='online'; name=text(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')).slice(0,120); }
    } else {
      const link=document.querySelector('a[data-e2e="nav-profile"],a[data-e2e="profile-link"],a[data-e2e="profile-icon"]');
      const match=/\\/@([^/]+)/.exec(href(link));
      if(match) { subjectId=match[1]; status='online'; name=text(document.querySelector('[data-e2e="profile-title"]')).slice(0,120); }
    }
    const identity={status,subjectId,displayName:name || null,checkedAt:new Date().toISOString()};
    const works=[], seen=new Set();
    if(status==='online') {
      const rows=platform==='youtube' ? document.querySelectorAll('ytcp-video-row') : platform==='x' ? document.querySelectorAll('article[data-testid="tweet"]') : document.querySelectorAll('tr,[data-e2e="video-card"],[data-e2e="post-item"]');
      for(const row of rows) {
        if(works.length>=30) break;
        const links=Array.from(row.querySelectorAll('a[href]'));
        const link=links.find(a => platform==='youtube' ? /\\/video\\/[a-zA-Z0-9_-]{11}\\//.test(href(a)) : platform==='x' ? new RegExp('/'+subjectId+'/status/\\\\d+','i').test(href(a)) : new RegExp('/@'+subjectId.replace(/[.*+?^$()|[\\]\\\\]/g,'\\\\$&')+'/video/\\\\d+').test(href(a)));
        if(!link) continue;
        const path=new URL(href(link)).pathname;
        const id=(platform==='youtube' ? /\\/video\\/([a-zA-Z0-9_-]{11})/ : /\\/(?:status|video)\\/(\\d+)/).exec(path)?.[1];
        if(!id || seen.has(id)) continue; seen.add(id);
        const url=platform==='youtube' ? 'https://www.youtube.com/watch?v='+id : href(link);
        const title=text(row.querySelector('#video-title,[data-testid="tweetText"],[data-e2e="video-desc"]') || link);
        const metrics={};
        for(const [key,selector] of Object.entries({views:'[data-testid="analytics"],.tablecell-views,[data-e2e="video-views"]',likes:'[data-testid="like"],.tablecell-likes',comments:'[data-testid="reply"],.tablecell-comments',shares:'[data-testid="retweet"]'})) {
          const value=text(row.querySelector(selector)); if(/^(?:[0-9,. ]+)(?:[KMBkmb万亿千])?$/.test(value) && value.length<=40) metrics[platform==='x' && key==='views' ? 'impressions' : key]=value;
        }
        works.push({remoteId:id,title,url,publishedAt:row.querySelector('time')?.getAttribute('datetime') || null,metrics});
      }
    }
    return {...base,identity,works};
  })()`;
}
