# Privacy policy: Doc Explainer

_Last updated: 2026-11-02_

Doc Explainer is a Chrome extension that explains text in PDF documents with an AI service you
choose in its settings: **Google Gemini**, **OpenAI** or **Anthropic Claude**, using an API key
that you provide for that service. It has no server of its own: its developer receives no data
from you at all.

## What the extension handles, and where it goes

Data goes only to the AI service chosen in the side panel's **Settings**, at that service's
official API address. The other services receive nothing.

| Data | Sent to | When |
|---|---|---|
| Text of PDF documents that open in the extension's viewer | The chosen AI service | While an API key for it is set: the text once per document, to build a summary; then the current page, related passages and the summary with each explanation or question |
| Text you select and click **Explain** on; questions you type in the side panel | The chosen AI service | Each time you click **Explain** or send a question |
| Your API key for a service | Only that service, in a request header | With every request to it, and once to check it when you save it |
| Settings (theme, answer source, language, chosen AI service) | Nowhere; Chrome may sync them between your own signed-in browsers (`chrome.storage.sync`) | — |

The official addresses are `generativelanguage.googleapis.com` (Gemini), `api.openai.com`
(OpenAI) and `api.anthropic.com` (Claude). A key is never sent to another service's address; a key
that is clearly another service's (for example a Gemini key entered as an OpenAI key) is refused
before anything is sent.

PDFs are opened in the extension's viewer automatically when Chrome loads them. To recognise them,
the extension looks at the response headers (such as the content type) of pages and files you
load; this happens inside your browser, and nothing of it is stored or sent anywhere. The viewer
downloads the PDF from its own address, as Chrome's built-in viewer would. The extension does not
read the content of other web pages, your browsing history, or any other data.

When you choose **Web assisted**, the chosen service may search the web to answer, as part of the
request: Google Search for Gemini, OpenAI's web search tool, or Claude's web search tool.

## How the AI services handle the data

The data above is sent under your own API key and is governed by that service's terms and privacy
policy. Check the current terms for your key and account, and do not open documents in the viewer
that you are not allowed to share with the service you chose.

- **Google Gemini:** the [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms)
  and the [Google Privacy Policy](https://policies.google.com/privacy). Google's terms say that on
  the free (unpaid) tier submitted content may be used to improve Google's products, and that on a
  paid tier it is not.
- **OpenAI:** the [OpenAI Services Agreement and policies](https://openai.com/policies/) and the
  [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/). The extension asks OpenAI
  not to store its responses for later retrieval (`store: false`).
- **Anthropic Claude:** [Anthropic's Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
  and the [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy). With **Web assisted**,
  Claude's web search can filter results in Anthropic's code-execution containers, whose data
  Anthropic's documentation says is kept for up to 30 days.

## What is stored on your computer

- **API keys:** one per service, in Chrome's session storage, deleted when the browser closes; or,
  if you tick **Remember on this device**, in Chrome's local extension storage on this computer
  (not encrypted, never synced) until you click **Forget key** or untick the box.
- **Document summaries, answers and chat:** in Chrome's session storage, in memory only, and
  deleted when the document's last tab closes or the browser closes.
- **Settings:** theme, answer source, language and chosen AI service, in Chrome's sync storage.

The extension writes nothing about your documents to disk, uses no tracking cookies, analytics or
tracking, and loads no remote code. When downloading a PDF, it may send the source website's
existing cookies to that website so that documents requiring sign-in can be opened.

## What the developer does not do

The developer does not collect, receive, sell or share any user data, and does not use it for any
purpose. The use of information received from Google APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Your choices

- Choose which AI service is used, or none: without a key for the chosen service, the extension
  sends nothing.
- Remove a key with **Forget key** in the side panel; uninstalling the extension removes all its
  stored data.
- Revoke or restrict the key itself with the service: [Google AI Studio](https://aistudio.google.com/apikey),
  the [OpenAI Platform](https://platform.openai.com/api-keys) or the
  [Claude Console](https://platform.claude.com/settings/keys).

## Contact

**Yagmur Karakus** — [GitHub profile](https://github.com/kyagmur1).

For privacy questions, open an issue at [doc_explainer Issues](https://github.com/kyagmur1/doc_explainer/issues).
Do not include API keys, private documents or sensitive download links in a public issue.

Changes to this policy are published in this file, with a new date above.
