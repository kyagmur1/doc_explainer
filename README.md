# Doc Explainer

**Understand the difficult part of a PDF without leaving the page.**

Select a term or passage in a PDF, click **Explain**, and get a short explanation beside it. Ask follow-ups in the side panel, in 11 languages. A Chrome extension that runs on **your own API key** for Gemini, OpenAI or Claude.

![Selected text in a PDF with a plain-language explanation in a speech bubble](docs/images/selection-explanation.png)

## Features

- Explanations that use the current page and the document's context
- Follow-up chat in the side panel
- Choose the AI service: **Gemini**, **OpenAI** or **Claude**
- **Only document** or **Web assisted** (adds the service's web search when your key allows it)
- 11 interface and answer languages, light and dark theme
- Page thumbnails and the PDF's own bookmarks

## Install

Requires Chrome 128 or later. Not on the Chrome Web Store yet.

1. **Code → Download ZIP**, then extract it to a folder you keep.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `chrome-extension` folder.
3. For local PDFs: **Details** → **Allow access to file URLs**.
4. Side panel → **Settings**: choose the AI service, paste its key and click **Save**. Keys: [Google AI Studio](https://aistudio.google.com/apikey) (Gemini, has a free tier), [OpenAI Platform](https://platform.openai.com/api-keys), [Claude Console](https://platform.claude.com/settings/keys). OpenAI and Claude API keys are paid and separate from a ChatGPT or Claude subscription.
5. Open a PDF, select text, click **Explain**.

To update: replace the files in the same folder, then click **Reload** in `chrome://extensions`.

## AI services and costs

Each service uses one low-cost model for explanations, chat and the document summary. Prices are
per 1M tokens as listed by the providers in November 2026; check their pricing pages before use.

| Service | Model | Input / output price | Web assisted |
|---|---|---|---|
| Gemini | `gemini-3.5-flash-lite` | $0.30 / $2.50, free tier available | Google Search: 5,000 searches/month free on paid keys, then $14 per 1,000; not on the free tier |
| OpenAI | `gpt-6-luna` | $0.10 / $0.50 | $10 per 1,000 searches, plus search content billed as input |
| Claude | `claude-haiku-5-5` | $0.10 / $0.50 (prompts up to 100k tokens) | $10 per 1,000 searches, at most 3 per answer |

Requests are never moved to another, more expensive model. Gemini allows 10 requests per minute in
the extension; when a request has to wait, the bubble and side panel say so, and your
explanations and questions go before the document summary.

## Privacy and API usage

**Your PDF text is sent to the AI service you choose** (Google, OpenAI or Anthropic). There is no developer backend.

- With a key set, opening a PDF sends its text to the chosen service in parts to build a summary. Explanations and chat send the selection plus related context.
- This uses your API quota and may cost money. Large PDFs use more tokens.
- Each service's key stays in session storage and is sent only to that service. **Remember on this device** stores it unencrypted in your Chrome profile; it is never synced.
- Summaries and chats are deleted when the PDF's last tab closes.

Details: [PRIVACY.md](PRIVACY.md).

## Limitations

- PDFs only, and they need selectable text; scans without a text layer won't work.
- AI answers can be wrong. Check important points against the document.

## Feedback and license

Made by [Yagmur Karakus](https://github.com/kyagmur1). Report bugs in **Issues**, but never post an API key or a private document.

[MIT](LICENSE). Bundled PDF.js is by Mozilla, under the [Apache-2.0 license](chrome-extension/vendor/pdfjs/LICENSE).
