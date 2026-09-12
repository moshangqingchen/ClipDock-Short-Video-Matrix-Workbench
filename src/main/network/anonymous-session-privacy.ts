import { app, type Session, type WebContents, type Event, type Certificate } from "electron";

export interface AnonymousCertificateScope {
  session: Session;
  abort: AbortController;
  /** Exact anonymous-reserved URLs only. Callers never register an account/business URL. */
  urls: ReadonlySet<string>;
}

const guards = new Set<AnonymousCertificateScope>();
const rejectClientCertificate = (
  event: Event,
  webContents: WebContents | null,
  url: string,
  _certificates: Certificate[],
  callback: (certificate?: Certificate) => void,
) => {
  const matching = [...guards].filter(
    (scope) => scope.urls.has(url) && (!webContents || webContents.session === scope.session),
  );
  if (!matching.length) return;
  // Without WebContents Electron gives no Session/request identity. URL equality
  // is a reserved-destination policy, not attribution: another main fetch to that
  // exact anonymous URL can also be denied. Merely aborting ours would leave the
  // event's default behavior free to select the first OS certificate.
  event.preventDefault();
  for (const scope of matching) scope.abort.abort();
  callback();
};

/** One listener across all anonymous probe factories, so each event is answered at most once. */
export function guardAnonymousClientCertificates(scope: AnonymousCertificateScope): () => void {
  if (!guards.size) app.on("select-client-certificate", rejectClientCertificate);
  guards.add(scope);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    guards.delete(scope);
    if (!guards.size) app.off("select-client-certificate", rejectClientCertificate);
  };
}

/** Apply only to a newly owned, nonpersistent anonymous Session. Does not grant network access. */
export function configureAnonymousCredentials(ses: Session): void {
  ses.allowNTLMCredentialsForDomains("");
  ses.setCertificateVerifyProc(null);
}
