# Doc Explainer

**Understand the difficult part of a PDF without leaving the page.**

Select a term or passage in a PDF, click **Explain**, and get a short explanation beside it. Ask follow-ups in the side panel, in 11 languages. A Chrome extension that runs on **your own Gemini API key**.

![Selected text in a PDF with a plain-language explanation in a speech bubble](docs/images/selection-explanation.png)

## Features

- Explanations that use the current page and the document's context
- Follow-up chat in the side panel
- **Only document** or **Web assisted** (adds Google Search when your key allows it)
- 11 interface and answer languages, light and dark theme
- Page thumbnails and the PDF's own bookmarks

## Install

Requires Chrome 128 or later. Not on the Chrome Web Store yet.

1. **Code → Download ZIP**, then extract it to a folder you keep.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `chrome-extension` folder.
3. For local PDFs: **Details** → **Allow access to file URLs**.
4. Side panel → **Settings**: paste a key from [Google AI Studio](https://aistudio.google.com/apikey) and click **Save**.
5. Open a PDF, select text, click **Explain**.

To update: replace the files in the same folder, then click **Reload** in `chrome://extensions`.

## Privacy and API usage

**Your PDF text is sent to Google's Gemini API.** There is no developer backend.

- With a key set, opening a PDF sends its text to Gemini in parts to build a summary. Explanations and chat send the selection plus related context.
- This uses your API quota and may cost money. Large PDFs use more tokens.
- The key stays in session storage. **Remember on this device** stores it unencrypted in your Chrome profile; it is never synced.
- Summaries and chats are deleted when the PDF's last tab closes.

Details: [PRIVACY.md](PRIVACY.md).

## Limitations

- Gemini only.
- PDFs only, and they need selectable text; scans without a text layer won't work.
- AI answers can be wrong. Check important points against the document.

## Feedback and license

Made by [Yagmur Karakus](https://github.com/kyagmur1). Report bugs in **Issues**, but never post an API key or a private document.

[MIT](LICENSE). Bundled PDF.js is by Mozilla, under the [Apache-2.0 license](chrome-extension/vendor/pdfjs/LICENSE).
