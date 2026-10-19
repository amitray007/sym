// The worker calls back on a URL Sym puts in its brief. Eve builds webhook URLs from its own idea
// of the host (localhost:3000 off Vercel), which a worker on another machine cannot reach.
// SYM_CALLBACK_URL is the base the worker can reach, such as Sym's address on the private
// network; the path and token from Eve stay as they are.
export function callbackFor(webhookUrl: string, base: string | undefined): string {
  if (!base) return webhookUrl;
  const hook = new URL(webhookUrl);
  return `${base.replace(/\/+$/, "")}${hook.pathname}${hook.search}`;
}
