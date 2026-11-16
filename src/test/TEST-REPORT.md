# Local PDF Tools: test report

2026-11-16 · 41 of 41 passed · run with `npm test`

The built file was opened from disk in headless Chrome, the way people open it. Every download was checked with pdf-lib (page count, order, size, rotation) and every ZIP with `unzip -t`.

| Area | Test | Result |
|---|---|---|
| Core | page ranges: 1-3, 5, 8- | Pass |
| Core | page ranges: -2, last, 3 to 1, en dash | Pass |
| Core | page ranges: clear errors for 0, too high, text, empty | Pass |
| Core | pages to text: [0,1,2,4,6,7] → 1-3, 5, 7-8 | Pass |
| Core | CRC-32 matches the standard check value | Pass |
| Core | file names can't contain path characters | Pass |
| Core | ZIP files open with unzip | Pass |
| Page | opens from a file with no errors | Pass |
| Page | blocks every network request (Content Security Policy) | Pass |
| Page | tabs switch with clicks and arrow keys | Pass |
| Page | every button has a name and every image has alt text | Pass |
| Merge | two PDFs, reordered, merged in the chosen order | Pass |
| Merge | real documents with embedded fonts | Pass |
| Merge | remove a file, then Merge needs two files | Pass |
| Merge | refuses a non-PDF file with a clear message | Pass |
| Merge | refuses a damaged PDF with a clear message | Pass |
| Merge | refuses a password-protected PDF and says why | Pass |
| Merge | unsafe output names are cleaned | Pass |
| Merge | 150-page file merges in under 10 seconds | Pass |
| Split | keep pages typed as 2-3, 6 | Pass |
| Split | keep pages picked by clicking previews | Pass |
| Split | a backwards range reverses the pages | Pass |
| Split | a page that doesn't exist disables the button and explains | Pass |
| Split | every page separately → ZIP with 7 one-page PDFs | Pass |
| Split | every 3 pages → 1-3, 4-6, 7 | Pass |
| Split | my own parts: 1-2, 3-7 | Pass |
| Split | one part only gives a PDF, not a ZIP | Pass |
| Split | page previews are drawn (opened from a file) | Pass |
| Split | choose another file resets the tool | Pass |
| Pages | move, rotate and delete, then download | Pass |
| Pages | rotating four times returns to upright | Pass |
| Pages | a deleted page can be kept again | Pass |
| Pages | Undo all changes restores the original order | Pass |
| Pages | removing every page disables download | Pass |
| Pages | keyboard: focus stays on the moved page's button | Pass |
| Images | PNG, JPEG and WebP become one A4 PDF, one image per page | Pass |
| Images | phone photo with a rotation tag comes out the right way up | Pass |
| Images | US Letter with a large margin | Pass |
| Images | refuses files that aren't images | Pass |
| Layout | no sideways scrolling on a 375px phone | Pass |
| Layout | dark mode uses dark colours | Pass |
