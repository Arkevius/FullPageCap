// Minimal PDF writer: builds a PDF whose pages each contain a single JPEG
// image (DCTDecode passthrough — no re-encoding). Enough for screenshot
// export without pulling in a PDF library.
//
// buildPdf(pages) where pages = [{ jpegBytes: Uint8Array, pxWidth, pxHeight,
// ptWidth, ptHeight }] returns a Blob. Pixel sizes describe the embedded
// image; point sizes the PDF page (image is drawn to fill the page).

const encoder = new TextEncoder();

export function buildPdf(pages) {
  const chunks = []; // Uint8Array | string pieces, flattened at the end
  let offset = 0;
  const xref = []; // byte offset per object number (1-based)

  function push(part) {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    offset += bytes.length;
  }

  function beginObj(num) {
    xref[num] = offset;
    push(`${num} 0 obj\n`);
  }

  push('%PDF-1.4\n%âãÏÓ\n');

  // Object layout: 1 = catalog, 2 = pages tree, then per page i:
  // pageObj, contentObj, imageObj.
  const pageObjNums = pages.map((_, i) => 3 + i * 3);
  const totalObjs = 2 + pages.length * 3;

  beginObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObj(2);
  push(
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] ` +
      `/Count ${pages.length} >>\nendobj\n`
  );

  pages.forEach((page, i) => {
    const pageNum = 3 + i * 3;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;
    const w = round2(page.ptWidth);
    const h = round2(page.ptHeight);

    beginObj(pageNum);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im${i} ${imageNum} 0 R >> ` +
        `/ProcSet [/PDF /ImageC] >> /Contents ${contentNum} 0 R >>\nendobj\n`
    );

    const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im${i} Do\nQ\n`;
    beginObj(contentNum);
    push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    beginObj(imageNum);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.pxWidth} ` +
        `/Height ${page.pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${page.jpegBytes.length} >>\nstream\n`
    );
    push(page.jpegBytes);
    push('\nendstream\nendobj\n');
  });

  const xrefStart = offset;
  push(`xref\n0 ${totalObjs + 1}\n`);
  push('0000000000 65535 f \n');
  for (let n = 1; n <= totalObjs; n++) {
    push(`${String(xref[n]).padStart(10, '0')} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  );

  return new Blob(chunks, { type: 'application/pdf' });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export const PAPER_SIZES = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};
