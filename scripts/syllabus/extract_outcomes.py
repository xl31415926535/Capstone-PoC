"""Extract learning outcomes from the MOE Primary Science syllabus PDF.

Developer tool, not needed to run the app. Requires poppler-utils (pdftotext).
Usage: python3 scripts/syllabus/extract_outcomes.py SYLLABUS.pdf > outcomes-raw.json

The outcome pages use a three-column table (Core Ideas, Practices, Values,
Ethics and Attitudes). Words are read with their bounding boxes, grouped into
lines by vertical centre, split at column gutters and then parsed into
bullets, sub-points and notes. The result still needs the manual corrections
applied by build_syllabus.py.
"""
import json
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

XHTML = '{http://www.w3.org/1999/xhtml}'
FIRST_PDF_PAGE, LAST_PDF_PAGE = 39, 81  # printed pages 38-80
COLUMN_EDGES = (300, 585)  # x positions separating the three columns (points)
HEADERS = ('Core Ideas', 'Practices', 'Values, Ethics and Attitudes')


def column(x):
    return 0 if x < COLUMN_EDGES[0] else 1 if x < COLUMN_EDGES[1] else 2


def read_pages(pdf):
    with tempfile.NamedTemporaryFile(suffix='.html') as out:
        subprocess.run(['pdftotext', '-bbox-layout', '-f', str(FIRST_PDF_PAGE), '-l', str(LAST_PDF_PAGE), pdf, out.name], check=True)
        root = ET.parse(out.name).getroot()
    for index, page in enumerate(root.iter(XHTML + 'page')):
        words = [dict(x0=float(w.get('xMin')), y0=float(w.get('yMin')), x1=float(w.get('xMax')), y1=float(w.get('yMax')), t=w.text or '')
                 for w in page.iter(XHTML + 'word')]
        yield FIRST_PDF_PAGE + index, words


def lines_of(words, tolerance=4.0):
    """Group words into lines per column. Bullets and sub-point dashes sit a
    little off the text baseline, so lines are grouped by vertical centre."""
    bands = []
    for word in sorted(words, key=lambda w: (w['y0'] + w['y1']) / 2):
        centre = (word['y0'] + word['y1']) / 2
        if bands and abs(bands[-1]['c'] - centre) <= tolerance:
            bands[-1]['words'].append(word)
        else:
            bands.append({'c': centre, 'words': [word]})
    lines = []
    for band in bands:
        segments = []
        for word in sorted(band['words'], key=lambda w: w['x0']):
            # Inter-word gaps are about 3 pt; column gutters are wider.
            if segments and word['x0'] - segments[-1][-1]['x1'] < 6:
                segments[-1].append(word)
            else:
                segments.append([word])
        by_column = {}
        for segment in segments:
            by_column.setdefault(column(segment[0]['x0']), []).extend(segment)
        for col, col_words in by_column.items():
            col_words.sort(key=lambda w: w['x0'])
            lines.append(dict(y0=min(w['y0'] for w in col_words), x0=min(w['x0'] for w in col_words), col=col,
                              text=' '.join(w['t'] for w in col_words).strip()))
    return sorted(lines, key=lambda l: (l['y0'], l['x0']))


def join(previous, text):
    if not previous:
        return text
    if previous.endswith('-') and not previous.endswith(' -'):
        return previous + text  # keep compounds such as "water-carrying"
    return previous + ' ' + text


def parse(pdf):
    topics = []
    for pdf_page, words in read_pages(pdf):
        lines = lines_of(words)
        if sum(l['text'] in HEADERS for l in lines) < 3:
            continue  # theme introduction pages have no outcome table
        printed = pdf_page - 1
        title = ' '.join(l['text'] for l in lines if l['y0'] < 92)
        match = re.match(r'^(.*) \((P\d)(?: (Standard|Foundation))?\)$', title)
        if not match:
            raise SystemExit(f'Unrecognised outcome page title on PDF page {pdf_page}: {title}')
        if topics and topics[-1]['title'] == title:
            topic = topics[-1]
            topic['pages'].append(printed)
        else:
            topic = dict(title=title, name=match.group(1), level=match.group(2), stream=(match.group(3) or 'All').lower(),
                         pages=[printed], columns=[[], [], []], state=[{}, {}, {}])
            topics.append(topic)
        for col in range(3):
            body = [l for l in lines if l['col'] == col and 122 < l['y0'] < 525]
            items, state = topic['columns'][col], topic['state'][col]
            left = min((l['x0'] for l in body), default=0)
            for line in body:
                text = line['text']
                if text.startswith('•'):
                    items.append(dict(kind='outcome', text=text.lstrip('• ').strip(), points=[], notes=[], page=printed))
                    state.update(note=False, last='outcome')
                elif re.match(r'^Notes?:', text):
                    rest = re.sub(r'^Notes?:\s*', '', text)
                    if not items:
                        items.append(dict(kind='context', text='', points=[], notes=[], page=printed))
                    if rest:
                        items[-1]['notes'].append(rest)
                    state.update(note=True, last='note-header')
                elif text.startswith('- ') or text == '-':
                    if not items:
                        items.append(dict(kind='context', text='', points=[], notes=[], page=printed))
                    target = items[-1]['notes'] if state.get('note') else items[-1]['points']
                    target.append(text[1:].strip())
                    state['last'] = 'note' if state.get('note') else 'point'
                elif not items:
                    items.append(dict(kind='heading', text=text, points=[], notes=[], page=printed))
                    state['last'] = 'heading'
                else:
                    last = items[-1]
                    if state.get('last') == 'point' and last['points']:
                        last['points'][-1] = join(last['points'][-1], text)
                    elif state.get('last') == 'note' and last['notes']:
                        last['notes'][-1] = join(last['notes'][-1], text)
                    elif state.get('last') == 'note-header':
                        last['notes'].append(text)
                        state['last'] = 'note'
                    elif line['x0'] <= left + 3:
                        items.append(dict(kind='heading', text=text, points=[], notes=[], page=printed))
                        state.update(note=False, last='heading')
                    else:
                        last['text'] = join(last['text'], text)
    for topic in topics:
        del topic['state']
        for col in topic['columns']:
            for item in col:
                item['points'] = [p for p in item['points'] if p]
    return topics


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    json.dump(parse(sys.argv[1]), sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write('\n')
