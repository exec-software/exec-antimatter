# Bundled fonts

## ussr-stencil.ttf — USSR Stencil

- **Designers:** Anastasia Mihaleva, Jovanny Lemonad
- **Licence:** SIL Open Font License 1.1 — see `OFL.txt`, shipped with the font
- **Source:** https://www.1001fonts.com/ussr-stencil-font.html

Used for the Antimatter wordmark. The OFL permits bundling and redistribution as part of a
larger work; it forbids selling the font on its own, which is not something an application does.

The webfont TTF is the one vendored. The archive also carries an OTF and a specimen PDF; neither
is needed at runtime, so neither is committed.

## c64-keyboard.woff2 — C64 Keyboard

- **Author:** Levente Szabadkai — a reconstruction, traced from close-up photographs of keycaps
- **Licence:** CC0 1.0 Universal (public domain dedication) — see `CC0-1.0.txt`
- **Source:** https://github.com/szabadkai/c64-keyboard-font

Offered in Settings → Appearance → Fonts as a face for the interface, chat or code. CC0 requires
no attribution and permits commercial use, so bundling is unencumbered; this entry exists for
provenance rather than obligation.

The woff2 is the only file vendored — 7 KB for the whole family, against 21 KB for the TTF. The
repository also ships an OTF and a TTF, neither of which is needed at runtime.

Coverage is `U+0020`–`U+007E` (all printable ASCII, lowercase included), Latin-1 accents, a
handful of Latin Extended-A, en/em dashes, curly quotes, ellipsis, arrows, and a Private Use
block carrying the PETSCII graphics. There is no Cyrillic, Greek beyond π, or CJK, so text in
those scripts falls through to the stack's next face — which is why `fontStack()` always appends
the role's fallbacks rather than emitting a bare family.

Two things CC0 does not cover, per the project's own README: rights in the historical keycap
designs, and any Commodore trademark. The reconstruction describes itself as independent and
unofficial, and is not endorsed by Commodore.
