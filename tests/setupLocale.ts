// The UI language of the unit tests: DIASHOW_LOCALE (e.g. en-US, the language of GitHub's runner) or
// the machine's. i18n.ts reads navigator.language when it loads, so this runs before every test file;
// the release check runs the unit tests in German and in English (scripts/release-check.mjs).
const locale = process.env.DIASHOW_LOCALE
if (locale) Object.defineProperty(globalThis.navigator, 'language', { value: locale, configurable: true })
