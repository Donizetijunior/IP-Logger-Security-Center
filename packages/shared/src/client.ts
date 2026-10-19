import { UAParser } from 'ua-parser-js';

export type ClientClass = 'human_probable' | 'bot' | 'preview' | 'head_probe' | 'unknown';

const PREVIEW_PATTERNS = [
  /whatsapp/i, /telegrambot/i, /slackbot/i, /discordbot/i, /facebookexternalhit/i, /facebot/i,
  /twitterbot/i, /linkedinbot/i, /skypeuripreview/i, /google-?pagereader/i, /embedly/i, /vkshare/i,
  /pinterest/i, /iframely/i, /viber/i, /applebot/i, /bingpreview/i,
];
const BOT_PATTERNS = [
  /bot\b/i, /crawl/i, /spider/i, /scan/i, /curl\//i, /wget/i, /python-requests/i, /python-urllib/i,
  /go-http-client/i, /java\//i, /okhttp/i, /libwww/i, /httpclient/i, /axios/i, /node-fetch/i,
  /headlesschrome/i, /phantomjs/i, /nmap/i, /masscan/i, /zgrab/i, /nuclei/i, /sqlmap/i, /nikto/i,
  /postmanruntime/i, /insomnia/i, /monitor/i, /uptime/i, /pingdom/i, /statuscake/i, /lighthouse/i,
];

export interface ClientInfo {
  clientClass: ClientClass;
  deviceClass: string | null;
  browser: string | null;
  os: string | null;
}

/**
 * Classificação heurística e conservadora. "human_probable" NÃO é clique humano confirmado:
 * é um GET com User-Agent de navegador convencional e sem indício de bot/preview.
 */
export function classifyClient(method: string, userAgent: string | null): ClientInfo {
  let deviceClass: string | null = null;
  let browser: string | null = null;
  let os: string | null = null;
  if (userAgent) {
    const r = new UAParser(userAgent).getResult();
    deviceClass = r.device.type ?? (r.os.name ? 'desktop' : null);
    browser = r.browser.name ?? null;
    os = r.os.name ?? null;
  }
  if (method.toUpperCase() === 'HEAD') return { clientClass: 'head_probe', deviceClass, browser, os };
  if (!userAgent) return { clientClass: 'unknown', deviceClass, browser, os };
  if (PREVIEW_PATTERNS.some((p) => p.test(userAgent))) return { clientClass: 'preview', deviceClass, browser, os };
  if (BOT_PATTERNS.some((p) => p.test(userAgent))) return { clientClass: 'bot', deviceClass, browser, os };
  if (browser && os) return { clientClass: 'human_probable', deviceClass, browser, os };
  return { clientClass: 'unknown', deviceClass, browser, os };
}
