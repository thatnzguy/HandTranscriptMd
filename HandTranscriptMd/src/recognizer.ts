/* =============================================
   Recognizer — Abstraction layer for OCR via Gemini
   Works on both Windows and Android.
   Receives a base64 PNG image, sends it to the
   Gemini API, and returns the recognised text.
   The IRecognizer interface allows adding alternative
   OCR backends in the future without touching embed.ts.
   ============================================= */

import { requestUrl } from 'obsidian';

// Modello Gemini da usare per il riconoscimento visivo
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Tipo della risposta JSON di Gemini (solo i campi che ci servono)
interface GeminiResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
	}>;
	error?: { message?: string };
}

/* ---------- Interfaccia comune ---------- */
// Mantiene l'astrazione: in futuro si può aggiungere un backend
// alternativo (es. OCR locale) senza modificare embed.ts

export interface IRecognizer {
	recognize(imageBase64: string): Promise<string>;
}

/* ---------- GeminiRecognizer ---------- */

class GeminiRecognizer implements IRecognizer {
	constructor(
		private apiKey: string,
		private languages: string[],
		// Optional extra instructions appended to the base OCR prompt (from settings)
		private customPrompt = ''
	) {}

	async recognize(imageBase64: string): Promise<string> {
		// Build the prompt, specifying the expected languages and output format
		const langList = this.languages.join(', ');
		let prompt =
			`Sei un sistema OCR specializzato in scrittura a mano. ` +
			`Analizza l'immagine e trascrivi esattamente il testo scritto. ` +
			`Le lingue attese sono: ${langList}. ` +
			`Preserva i simboli markdown scritti dall'utente ` +
			`(es. #, ##, ###, -, *, >, \`\`\`, **testo**, *testo*, ==testo==, ~~testo~~, - [ ], - [x]). ` +
			`Restituisci SOLO il testo trascritto, senza alcuna spiegazione aggiuntiva.`;

		// Append the user's custom instructions, if any
		const extra = this.customPrompt.trim();
		if (extra) {
			prompt += `\n\nAdditional instructions: ${extra}`;
		}

		// requestUrl è la funzione Obsidian per le richieste HTTP:
		// funziona uguale su Desktop e Android (a differenza di fetch nativo).
		// throw: false → non lancia eccezione su 4xx: gestiamo lo status manualmente.
		const resp = await requestUrl({
			url: `${GEMINI_URL}?key=${this.apiKey}`,
			method: 'POST',
			contentType: 'application/json',
			throw: false,
			body: JSON.stringify({
				contents: [{
					parts: [
						// Immagine PNG in base64
						{ inline_data: { mime_type: 'image/png', data: imageBase64 } },
						// Istruzioni OCR
						{ text: prompt }
					]
				}]
			})
		});

		// Gestione errori HTTP (chiave non valida, quota esaurita, ecc.)
		if (resp.status !== 200) {
			const errJson = resp.json as GeminiResponse;
			throw new Error(`Gemini ${resp.status}: ${errJson?.error?.message ?? String(resp.status)}`);
		}

		const json = resp.json as GeminiResponse;
		// Estrae il testo dal primo candidato
		const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
		return text.trim();
	}
}

/* ---------- Factory ---------- */

// Throws immediately if the key is missing, so embed.ts can show
// a clear warning to the user before calling the API.
// customPrompt: optional extra instructions appended to the OCR prompt.
export function getRecognizer(apiKey: string, languages: string[], customPrompt = ''): IRecognizer {
	if (!apiKey.trim()) {
		throw new Error('Chiave API Gemini non configurata — aprire le impostazioni del plugin');
	}
	return new GeminiRecognizer(apiKey, languages, customPrompt);
}
