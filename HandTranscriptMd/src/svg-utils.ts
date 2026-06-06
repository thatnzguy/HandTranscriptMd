/* =============================================
   SVG Utilities — Conversione tratti ↔ SVG
   I tratti vengono salvati come <path> nell'SVG,
   e i dati grezzi in un elemento <desc> (JSON)
   per poter ricaricare e rieditare il disegno.
   ============================================= */

import { Point, Stroke, LINE_SPACING } from './drawing-canvas';

// Genera ID univoco per nuovi disegni nel formato HTMD_YYYYMMDDHHMMSS_XXXX
export function generateId(): string {
	const now = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
	const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	const rnd  = Math.random().toString(36).substring(2, 6).toUpperCase();
	return `HTMD_${date}${time}_${rnd}`;
}

// Converte un array di punti in un attributo SVG path "d"
// Usa curve quadratiche Bézier con midpoint per smoothing
function pointsToPathD(points: Point[]): string {
	if (points.length < 2) return '';

	const parts: string[] = [];
	// Move to primo punto
	parts.push(`M ${r(points[0]!.x)},${r(points[0]!.y)}`);

	if (points.length === 2) {
		parts.push(`L ${r(points[1]!.x)},${r(points[1]!.y)}`);
	} else {
		// Curve quadratiche con midpoint (stessa tecnica del canvas)
		for (let i = 1; i < points.length - 1; i++) {
			const curr = points[i]!;
			const next = points[i + 1]!;
			const midX = (curr.x + next.x) / 2;
			const midY = (curr.y + next.y) / 2;
			parts.push(`Q ${r(curr.x)},${r(curr.y)} ${r(midX)},${r(midY)}`);
		}
		// Ultimo punto
		const last = points[points.length - 1]!;
		parts.push(`L ${r(last.x)},${r(last.y)}`);
	}

	return parts.join(' ');
}

// Arrotonda a 1 decimale per SVG più compatti
function r(n: number): string {
	return Math.round(n * 10) / 10 + '';
}

// Numeric round to 1 decimal — used for the coordinates stored in the
// <desc> JSON, so the re-edit data is as compact as the rendered paths.
function r1(n: number): number {
	return Math.round(n * 10) / 10;
}

// Perpendicular distance from point p to the infinite line through a and b.
function perpendicularDistance(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
	return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

// Ramer–Douglas–Peucker polyline simplification.
// Removes points that lie within `epsilon` of the line between their
// neighbours, drastically reducing point count for handwriting strokes
// with no visible quality loss. Returns a new array.
export function rdpSimplify(points: Point[], epsilon: number): Point[] {
	if (points.length <= 2 || epsilon <= 0) return points;

	const first = points[0]!;
	const last = points[points.length - 1]!;
	let maxDist = 0;
	let idx = 0;
	for (let i = 1; i < points.length - 1; i++) {
		const d = perpendicularDistance(points[i]!, first, last);
		if (d > maxDist) { maxDist = d; idx = i; }
	}

	if (maxDist > epsilon) {
		const left = rdpSimplify(points.slice(0, idx + 1), epsilon);
		const right = rdpSimplify(points.slice(idx), epsilon);
		// Drop the duplicated join point (last of left === first of right)
		return left.slice(0, -1).concat(right);
	}
	return [first, last];
}

// Epsilon for stroke simplification, in canvas pixels. 0.5 is conservative —
// it preserves curve smoothness while removing redundant intermediate points.
const SIMPLIFY_EPSILON = 0.5;

// Converte array di Stroke in contenuto SVG completo.
// I tratti vengono semplificati (RDP) e i dati grezzi salvati in <desc> come
// JSON compatto (coordinate arrotondate, campo pressure rimosso) per permettere
// il riedit mantenendo i file piccoli.
export function strokesToSvg(
	strokes: Stroke[], width: number, height: number,
	bgColor = '#ffffff', lineColor = '#e0e0e0'
): string {
	const paths: string[] = [];
	// Compact stroke data for the <desc> JSON: simplified points, rounded
	// coordinates, no pressure field.
	const serializable: Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }> = [];

	for (const stroke of strokes) {
		const pts = rdpSimplify(stroke.points, SIMPLIFY_EPSILON);
		serializable.push({
			points: pts.map(p => ({ x: r1(p.x), y: r1(p.y) })),
			color: stroke.color,
			width: stroke.width,
		});
		const d = pointsToPathD(pts);
		if (!d) continue;
		paths.push(
			`  <path d="${d}" stroke="${stroke.color}" fill="none" ` +
			`stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`
		);
	}

	const strokesJson = JSON.stringify(serializable);

	// Righe orizzontali (foglio a righe) — stessa spaziatura del canvas
	const lines: string[] = [];
	for (let y = LINE_SPACING; y < height; y += LINE_SPACING) {
		lines.push(`  <line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${lineColor}" stroke-width="0.5"/>`);
	}

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
		`  <rect width="100%" height="100%" fill="${bgColor}"/>`,
		...lines,
		`  <desc class="hwm-strokes">${escapeXml(strokesJson)}</desc>`,
		...paths,
		`</svg>`
	].join('\n');
}

// Estrae i tratti dal JSON nella <desc> dell'SVG
// Restituisce array vuoto se non trova dati validi
export function parseSvgStrokes(svgContent: string): Stroke[] {
	try {
		// Cerca il contenuto del tag <desc class="hwm-strokes">
		const match = svgContent.match(/<desc class="hwm-strokes">([\s\S]*?)<\/desc>/);
		if (!match) return [];

		const json = unescapeXml(match[1] ?? '');
		// JSON.parse ritorna unknown; validazione esplicita prima di usare i dati
		const parsed: unknown = JSON.parse(json);

		// Validazione base: deve essere un array di oggetti con points, color, width
		if (!Array.isArray(parsed)) return [];
		return (parsed as unknown[]).filter((s): s is Stroke =>
			s !== null && typeof s === 'object' &&
			Array.isArray((s as Stroke).points) &&
			typeof (s as Stroke).color === 'string' &&
			typeof (s as Stroke).width === 'number'
		);
	} catch {
		return [];
	}
}

// Escape caratteri speciali XML per inserimento in <desc>
function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Ripristina i caratteri XML escapati
function unescapeXml(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');
}

// Converte un SVGElement in PNG base64 via canvas HTML temporaneo.
// Usato dalla pipeline OCR (embed.ts e editor-view.ts) prima di inviare a Gemini.
export function svgToBase64Png(svgElement: SVGElement): Promise<string> {
	return new Promise((resolve, reject) => {
		const cvs = activeDocument.createElement('canvas');
		const ctx = cvs.getContext('2d')!;
		const img = new Image();
		const blob = new Blob(
			[new XMLSerializer().serializeToString(svgElement)],
			{ type: 'image/svg+xml' }
		);
		const url = URL.createObjectURL(blob);
		img.onload = () => {
			cvs.width = img.width; cvs.height = img.height;
			ctx.drawImage(img, 0, 0);
			URL.revokeObjectURL(url);
			resolve(cvs.toDataURL('image/png').split(',')[1]!);
		};
		img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG → PNG fallito')); };
		img.src = url;
	});
}
