# Privacy policy: Doc Explainer

_Last updated: 2026-11-01_

Doc Explainer is a Chrome extension that explains text in PDF documents with Google's Gemini API,
using an API key that you provide. It has no server of its own: its developer receives no data
from you at all.

## What the extension handles, and where it goes

| Data | Sent to | When |
|---|---|---|
| Text of PDF documents that open in the extension's viewer | Google Gemini API (`generativelanguage.googleapis.com`) | While an API key is set: the whole text once per document, to build a summary; then the current page, related passages and the summary with each explanation or question |
| Text you select and click **Explain** on; questions you type in the side panel | Google Gemini API | Each time you click **Explain** or send a question |
| Your Gemini API key | Google Gemini API, in a request header | With every request to Gemini, and once to check it when you save it |
| Settings (theme, answer source, language) | Nowhere; Chrome may sync them between your own signed-in browsers (`chrome.storage.sync`) | — |

PDFs are opened in the extension's viewer automatically when Chrome loads them. To recognise them,
the extension looks at the response headers (such as the content type) of pages and files you
load; this happens inside your browser, and nothing of it is stored or sent anywhere. The viewer
downloads the PDF from its own address, as Chrome's built-in viewer would. The extension does not
read the content of other web pages, your browsing history, or any other data.

When you choose **Web assisted**, Gemini may use Google Search to answer; the search is done by
Google as part of the Gemini request.

## Google's handling of the data

The data above is sent to Google under your own API key and is governed by Google's terms for the
Gemini API (the [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms) and
the [Google Privacy Policy](https://policies.google.com/privacy)). Google's terms say that on the
free (unpaid) tier submitted content may be used to improve Google's products, and that on a paid
tier it is not; check the current terms for your key. Do not
open documents in the viewer that you are not allowed to share with Google under your key's terms.

## What is stored on your computer

- **API key:** in Chrome's session storage, deleted when the browser closes; or, if you tick
  **Remember on this device**, in Chrome's local extension storage on this computer (not
  encrypted, never synced) until you click **Forget key** or untick the box.
- **Document summaries, answers and chat:** in Chrome's session storage, in memory only, and
  deleted when the document's last tab closes or the browser closes.
- **Settings:** theme, answer source and language, in Chrome's sync storage.

The extension writes nothing about your documents to disk, uses no tracking cookies, analytics or
tracking, and loads no remote code. When downloading a PDF, it may send the source website's
existing cookies to that website so that documents requiring sign-in can be opened.

## What the developer does not do

The developer does not collect, receive, sell or share any user data, and does not use it for any
purpose. The use of information received from Google APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Your choices

- Remove your key with **Forget key** in the side panel; uninstalling the extension removes all
  its stored data.
- Revoke or restrict the key itself in [Google AI Studio](https://aistudio.google.com/apikey).
- Without a key, the extension sends nothing to Google.

## Contact

**Yagmur Karakus** — [GitHub profile](https://github.com/kyagmur1).

For privacy questions, open an issue at [doc_explainer Issues](https://github.com/kyagmur1/doc_explainer/issues).
Do not include API keys, private documents or sensitive download links in a public issue.

Changes to this policy are published in this file, with a new date above.
