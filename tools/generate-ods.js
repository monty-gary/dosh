const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'spreadsheet-ods');
const metaInfDir = path.join(buildDir, 'META-INF');
const outDir = path.join(root, 'spreadsheet');
const outFile = path.join(outDir, 'dosh-spreadsheet.ods');

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(metaInfDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const peopleRows = 20;
const expenseRows = 200;
const transferRows = 20;

const xml = String.raw;

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pCell(text) {
  return `<table:table-cell office:value-type="string"><text:p>${esc(text)}</text:p></table:table-cell>`;
}

function emptyCells(n) {
  return n > 0 ? `<table:table-cell table:number-columns-repeated="${n}"/>` : '';
}

function formulaCell(formula, valueType = 'float') {
  const valueAttrs = valueType === 'string' ? ' office:string-value=""' : ' office:value="0"';
  return `<table:table-cell table:formula="${esc(formula)}" office:value-type="${valueType}"${valueAttrs}><text:p/></table:table-cell>`;
}

function readmeSheet() {
  const rows = [
    ['dosh spreadsheet prototype'],
    [''],
    ['What it does'],
    ['- Add people on the People sheet'],
    ['- Add expenses on the Expenses sheet'],
    ['- Balances update automatically'],
    ['- Suggested transfers are shown on the Transfers sheet'],
    [''],
    ['How to fill expenses'],
    ['- Amount is a normal decimal amount, e.g. 249.90'],
    ['- Paid By must match a person name from People'],
    ['- Up to 4 split participants per expense row'],
    ['- Weights default to 1 for equal split'],
    ['- Leave unused participant/weight pairs blank'],
    [''],
    ['Limitations'],
    ['- Spreadsheet version is a template, not realtime'],
    ['- Suggested transfers are proportional, not perfectly minimal'],
    ['- Supports up to 20 people and 200 expenses in this template']
  ];

  const body = rows.map((row) => `<table:table-row>${row.map(pCell).join('')}${emptyCells(7)}</table:table-row>`).join('');
  return `<table:table table:name="README">${body}</table:table>`;
}

function peopleSheet() {
  let rows = `<table:table-row>${pCell('Person')}</table:table-row>`;
  for (let i = 2; i <= peopleRows + 1; i += 1) {
    rows += `<table:table-row>${formulaCell(`of:=IF(LEN([.A${i}])>0;[.A${i}];"")`, 'string')}</table:table-row>`;
  }
  return `<table:table table:name="People">${rows}</table:table>`;
}

function expensesSheet() {
  const header = ['Description', 'Amount', 'Paid By', 'Participant 1', 'Weight 1', 'Participant 2', 'Weight 2', 'Participant 3', 'Weight 3', 'Participant 4', 'Weight 4', 'Total Weight'];
  let rows = `<table:table-row>${header.map(pCell).join('')}</table:table-row>`;
  for (let r = 2; r <= expenseRows + 1; r += 1) {
    rows += `<table:table-row>` +
      pCell('') +
      `<table:table-cell office:value-type="float" office:value="0"><text:p/></table:table-cell>` +
      pCell('') + pCell('') +
      `<table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>` +
      pCell('') + `<table:table-cell office:value-type="float" office:value="0"><text:p/></table:table-cell>` +
      pCell('') + `<table:table-cell office:value-type="float" office:value="0"><text:p/></table:table-cell>` +
      pCell('') + `<table:table-cell office:value-type="float" office:value="0"><text:p/></table:table-cell>` +
      formulaCell(`of:=IF(LEN([.C${r}])=0;0;N([.E${r}])+N([.G${r}])+N([.I${r}])+N([.K${r}]))`) +
      `</table:table-row>`;
  }
  return `<table:table table:name="Expenses">${rows}</table:table>`;
}

function balancesSheet() {
  const header = ['Person', 'Paid', 'Owes', 'Net'];
  let rows = `<table:table-row>${header.map(pCell).join('')}</table:table-row>`;
  for (let r = 2; r <= peopleRows + 1; r += 1) {
    const person = `[.A${r}]`;
    const owes = [
      `SUMPRODUCT((Expenses.D$2:D$${expenseRows + 1}=${person})*(Expenses.B$2:B$${expenseRows + 1})*(Expenses.E$2:E$${expenseRows + 1})/IF(Expenses.L$2:L$${expenseRows + 1}=0;1;Expenses.L$2:L$${expenseRows + 1}))`,
      `SUMPRODUCT((Expenses.F$2:F$${expenseRows + 1}=${person})*(Expenses.B$2:B$${expenseRows + 1})*(Expenses.G$2:G$${expenseRows + 1})/IF(Expenses.L$2:L$${expenseRows + 1}=0;1;Expenses.L$2:L$${expenseRows + 1}))`,
      `SUMPRODUCT((Expenses.H$2:H$${expenseRows + 1}=${person})*(Expenses.B$2:B$${expenseRows + 1})*(Expenses.I$2:I$${expenseRows + 1})/IF(Expenses.L$2:L$${expenseRows + 1}=0;1;Expenses.L$2:L$${expenseRows + 1}))`,
      `SUMPRODUCT((Expenses.J$2:J$${expenseRows + 1}=${person})*(Expenses.B$2:B$${expenseRows + 1})*(Expenses.K$2:K$${expenseRows + 1})/IF(Expenses.L$2:L$${expenseRows + 1}=0;1;Expenses.L$2:L$${expenseRows + 1}))`
    ].join('+');
    rows += `<table:table-row>` +
      formulaCell(`of:=People.A${r}`, 'string') +
      formulaCell(`of:=IF(LEN(${person})=0;0;SUMIF(Expenses.C$2:C$${expenseRows + 1};${person};Expenses.B$2:B$${expenseRows + 1}))`) +
      formulaCell(`of:=IF(LEN(${person})=0;0;${owes})`) +
      formulaCell(`of:=IF(LEN(${person})=0;0;[.B${r}]-[.C${r}])`) +
      `</table:table-row>`;
  }
  return `<table:table table:name="Balances">${rows}</table:table>`;
}

function transfersSheet() {
  let rows = '';
  rows += `<table:table-row>${['Debtor', 'Owes', 'Creditor', 'Gets', 'Suggested transfer'].map(pCell).join('')}</table:table-row>`;
  for (let r = 2; r <= transferRows + 1; r += 1) {
    const peopleRange = `Balances.$A$2:$A$${peopleRows + 1}`;
    const netRange = `Balances.$D$2:$D$${peopleRows + 1}`;
    const negRank = `LARGE(IF(${netRange}<0;-${netRange});ROW()-1)`;
    const posRank = `LARGE(IF(${netRange}>0;${netRange});ROW()-1)`;
    rows += `<table:table-row>` +
      formulaCell(`of:=IFERROR(INDEX(${peopleRange};MATCH(${negRank};IF(${netRange}<0;-${netRange});0));"")`, 'string') +
      formulaCell(`of:=IFERROR(${negRank};0)`) +
      formulaCell(`of:=IFERROR(INDEX(${peopleRange};MATCH(${posRank};IF(${netRange}>0;${netRange});0));"")`, 'string') +
      formulaCell(`of:=IFERROR(${posRank};0)`) +
      formulaCell(`of:=IF(OR([.A${r}]="";[.C${r}]="");0;MIN([.B${r}];[.D${r}]*[.B${r}]/IF(SUMIF(Balances.D$2:D$${peopleRows + 1};">0";Balances.D$2:D$${peopleRows + 1})=0;1;SUMIF(Balances.D$2:D$${peopleRows + 1};">0";Balances.D$2:D$${peopleRows + 1}))))`) +
      `</table:table-row>`;
  }
  rows += `<table:table-row>${pCell('')} ${pCell('')} ${pCell('')} ${pCell('Total credit')} ${formulaCell(`of:=SUMIF(Balances.D$2:D$${peopleRows + 1};">0";Balances.D$2:D$${peopleRows + 1})`)}</table:table-row>`;
  return `<table:table table:name="Transfers">${rows}</table:table>`;
}

const contentXml = xml`<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"
  xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"
  xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"
  xmlns:ooo="http://openoffice.org/2004/office"
  xmlns:ooow="http://openoffice.org/2004/writer"
  xmlns:oooc="http://openoffice.org/2004/calc"
  xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"
  office:version="1.3">
  <office:scripts/>
  <office:automatic-styles/>
  <office:body>
    <office:spreadsheet>
      ${readmeSheet()}
      ${peopleSheet()}
      ${expensesSheet()}
      ${balancesSheet()}
      ${transfersSheet()}
    </office:spreadsheet>
  </office:body>
</office:document-content>
`;

const stylesXml = xml`<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"
  xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:version="1.3">
  <office:styles>
    <style:default-style style:family="table-cell">
      <style:table-cell-properties fo:padding="0.05in"/>
    </style:default-style>
  </office:styles>
  <office:automatic-styles/>
  <office:master-styles/>
</office:document-styles>
`;

const metaXml = xml`<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"
  office:version="1.3">
  <office:meta>
    <meta:generator>OpenClaw / Gary</meta:generator>
    <dc:title>dosh spreadsheet prototype</dc:title>
  </office:meta>
</office:document-meta>
`;

const settingsXml = xml`<?xml version="1.0" encoding="UTF-8"?>
<office:document-settings
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"
  office:version="1.3">
  <office:settings/>
</office:document-settings>
`;

const manifestXml = xml`<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest
  xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"
  manifest:version="1.3">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/>
</manifest:manifest>
`;

fs.writeFileSync(path.join(buildDir, 'mimetype'), 'application/vnd.oasis.opendocument.spreadsheet');
fs.writeFileSync(path.join(buildDir, 'content.xml'), contentXml);
fs.writeFileSync(path.join(buildDir, 'styles.xml'), stylesXml);
fs.writeFileSync(path.join(buildDir, 'meta.xml'), metaXml);
fs.writeFileSync(path.join(buildDir, 'settings.xml'), settingsXml);
fs.writeFileSync(path.join(metaInfDir, 'manifest.xml'), manifestXml);

fs.rmSync(outFile, { force: true });
execFileSync('zip', ['-X0', outFile, 'mimetype'], { cwd: buildDir, stdio: 'inherit' });
execFileSync('zip', ['-Xr9D', outFile, 'content.xml', 'styles.xml', 'meta.xml', 'settings.xml', 'META-INF/manifest.xml'], { cwd: buildDir, stdio: 'inherit' });

console.log(`Wrote ${outFile}`);
