import json
import re
import sys
from datetime import datetime, timedelta
import zipfile
import xml.etree.ElementTree as ET

NS = {'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'p':'http://schemas.openxmlformats.org/package/2006/relationships'}

def col_index(ref):
    letters = re.match(r'[A-Z]+', ref or 'A').group(0)
    n = 0
    for ch in letters: n = n * 26 + ord(ch) - 64
    return n - 1

def parse(path):
    with zipfile.ZipFile(path) as book:
        strings = []
        if 'xl/sharedStrings.xml' in book.namelist():
            root = ET.fromstring(book.read('xl/sharedStrings.xml'))
            strings = [''.join(t.text or '' for t in si.findall('.//m:t', NS)) for si in root.findall('m:si', NS)]
        workbook = ET.fromstring(book.read('xl/workbook.xml'))
        rels = ET.fromstring(book.read('xl/_rels/workbook.xml.rels'))
        targets = {rel.attrib['Id']: rel.attrib['Target'] for rel in rels.findall('p:Relationship', NS)}
        sheets = {}
        for sheet in workbook.findall('m:sheets/m:sheet', NS):
            target = targets[sheet.attrib['{'+NS['r']+'}id']].lstrip('/')
            if not target.startswith('xl/'): target = 'xl/' + target
            root = ET.fromstring(book.read(target))
            rows = []
            for row in root.findall('.//m:sheetData/m:row', NS):
                values = []
                for cell in row.findall('m:c', NS):
                    idx = col_index(cell.attrib.get('r'))
                    while len(values) <= idx: values.append('')
                    typ = cell.attrib.get('t')
                    if typ == 'inlineStr': value = ''.join(t.text or '' for t in cell.findall('.//m:t', NS))
                    else:
                        v = cell.find('m:v', NS); value = v.text if v is not None else ''
                        if typ == 's' and value: value = strings[int(value)]
                    values[idx] = value
                rows.append(values)
            if rows:
                headers = [str(v).strip() for v in rows[0]]
                records = []
                for values in rows[1:]:
                    if not any(str(v).strip() for v in values): continue
                    record = {}
                    for i, header in enumerate(headers):
                        key = header or f'Column {i+1}'
                        value = values[i] if i < len(values) else ''
                        lower = key.lower()
                        try:
                            numeric = float(value)
                            if 'date' in lower and numeric > 20000:
                                value = (datetime(1899, 12, 30) + timedelta(days=numeric)).date().isoformat()
                            elif ('time' in lower) and 0 <= numeric < 1:
                                minutes = round(numeric * 24 * 60)
                                value = f'{minutes // 60:02d}:{minutes % 60:02d}'
                        except (ValueError, TypeError):
                            pass
                        record[key] = value
                    records.append(record)
                sheets[sheet.attrib['name']] = records
        return sheets

try:
    print(json.dumps(parse(sys.argv[1]), ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
