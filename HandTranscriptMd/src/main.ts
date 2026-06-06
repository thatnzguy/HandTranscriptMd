/* =============================================
   Handwriting to Markdown — Plugin Entry Point

   Registra:
   - Code block processor "handwriting" (embed inline)
   - Comando per inserire un nuovo blocco handwriting
   - Tab impostazioni
   ============================================= */

import { Plugin, TFile, TFolder, Notice, FuzzySuggestModal, FuzzyMatch, Editor, debounce, TAbstractFile } from 'obsidian';
import { t, setLocale } from './i18n';
import { DEFAULT_SETTINGS, HandwritingSettings, HandwritingSettingTab } from './settings';
import { registerEmbed, insertHandwritingBlock, runOcrRaw, findTranscript, insertTranscript } from './embed';
import { VIEW_TYPE_HANDWRITING, DrawingEditorView } from './editor-view';

export default class HandwritingPlugin extends Plugin {
	settings: HandwritingSettings;

	// Mappa di callback per aggiornare le preview inline quando l'editor tab salva
	public previewCallbacks = new Map<string, (svgContent: string) => void>();

	// Mappa embedId → svgPath: permette di trovare i file SVG da rimappare al cambio bgMode
	public embedPaths = new Map<string, string>();

	// Callback notificate quando l'utente cambia bgMode nelle impostazioni
	public bgModeListeners = new Set<(bgMode: string) => void>();

	// Tracks files currently being modified by auto-OCR to prevent re-entrant processing
	private processingFiles = new Set<string>();

	// Map embedId → actions (expand/collapse/convert): used by the Obsidian "⋮" menu
	public embedActions = new Map<string, {
		expand:     () => void;
		collapse:   () => void;
		convert:    () => Promise<void>;
		container:  HTMLElement;
		sourcePath: string;
	}>();

	// Invocato dall'editor tab dopo ogni salvataggio per aggiornare la preview inline
	refreshPreview(id: string, svgContent: string) {
		this.previewCallbacks.get(id)?.(svgContent);
	}

	// Chiamato da settings quando l'utente cambia bgMode:
	// notifica pannelli (aggiornamento classe dark) e SVG attivi (remap colori)
	notifyBgModeChange() {
		this.bgModeListeners.forEach(cb => cb(this.settings.bgMode));
	}

	async onload() {
		await this.loadSettings();

		// Applica la lingua interfaccia salvata (o la lingua di sistema se 'auto')
		setLocale(this.settings.uiLanguage);

		// Rileva cambio tema Obsidian. Doppio meccanismo per massima compatibilità Android:
		// - css-change: evento Obsidian garantito al cambio tema (più affidabile su alcuni WebView Android)
		// - MutationObserver: fallback per cambii di classe body da plugin terzi o versioni vecchie
		this.registerEvent(
			this.app.workspace.on('css-change', () => {
				if (this.settings.bgMode === 'auto') this.notifyBgModeChange();
			})
		);
		const themeObserver = new MutationObserver(() => {
			if (this.settings.bgMode === 'auto') this.notifyBgModeChange();
		});
		themeObserver.observe(activeDocument.body, { attributeFilter: ['class'] });
		this.register(() => themeObserver.disconnect());

		// Auto-OCR on save: scan modified .md files for embeds without transcripts
		this.registerEvent(
			this.app.vault.on('modify', debounce((file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') {
					void this.handleAutoOcr(file);
				}
			}, 3000, true))
		);

		// Register the editor view (dedicated tab for drawing)
		this.registerView(VIEW_TYPE_HANDWRITING, (leaf) => new DrawingEditorView(leaf, this));

		// Register the code block processor for ```handwriting
		registerEmbed(this);

		// Comando: inserisce un nuovo blocco handwriting nel file corrente
		this.addCommand({
			id: 'insert-handwriting',
			name: 'Insert handwriting block',
			icon: 'pencil',
			editorCallback: () => { void insertHandwritingBlock(this); }
		});

		// Comando: inserisce un riferimento a un SVG esistente nella cartella handwriting
		this.addCommand({
			id: 'insert-svg-reference',
			name: 'Insert SVG reference',
			icon: 'file-plus',
			editorCallback: (editor: Editor) => {
				new SvgReferenceSuggest(this.app, this, editor).open();
			}
		});

		// Icona nella ribbon (sidebar sinistra)
		this.addRibbonIcon('pencil', 'Insert handwriting', () => { void insertHandwritingBlock(this); });

		// Tab impostazioni
		this.addSettingTab(new HandwritingSettingTab(this.app, this));

		// Voci nel menu "⋮" (tre puntini) di Obsidian per operazioni su tutti i disegni.
		// Vengono aggiunte con setSection('danger') e poi spostate prima di "Elimina file"
		// tramite (menu as any).items — l'unico modo per posizionarle nell'ultima sezione
		// sopra Delete senza usare API private più instabili.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				menu.addItem(item => item
					.setTitle(t('menu_expand_all'))
					.setIcon('chevrons-down')
					.setSection('danger')
					.onClick(() => {
						this.getActiveEmbeds(file.path).forEach(a => a.expand());
					})
				);
				menu.addItem(item => item
					.setTitle(t('menu_collapse_all'))
					.setIcon('chevrons-up')
					.setSection('danger')
					.onClick(() => {
						this.getActiveEmbeds(file.path).forEach(a => a.collapse());
					})
				);
				menu.addItem(item => item
					.setTitle(t('menu_convert_all'))
					.setIcon('file-text')
					.setSection('danger')
					.onClick(() => {
						// Sequenziale: si ferma al primo errore
						void (async () => {
							try {
								for (const actions of this.getActiveEmbeds(file.path)) {
									await actions.convert();
								}
							} catch (e: unknown) {
								new Notice(t('error_conversion') + (e instanceof Error ? e.message : String(e)));
							}
						})();
					})
				);
				// Sposta le 3 voci appena aggiunte prima del primo item 'danger' esistente
				// (cioè prima di "Elimina file"), in modo che compaiano sopra di esso.
				// Accesso a proprietà interna non pubblica di Menu: necessario per il riposizionamento.
			const items = (menu as unknown as { items: Array<{ section: string }> }).items;
				const added = items.splice(items.length - 3, 3);
				const firstDangerIdx = items.findIndex(i => i.section === 'danger');
				items.splice(firstDangerIdx >= 0 ? firstDangerIdx : items.length, 0, ...added);
			})
		);
	}

	// Returns the active embeds (container in DOM) belonging to the given file.
	// Removes from the map any embeds whose container is no longer in the DOM.
	private getActiveEmbeds(filePath: string) {
		const result: Array<{ expand: () => void; collapse: () => void; convert: () => Promise<void> }> = [];
		for (const [id, actions] of this.embedActions) {
			if (!actions.container.isConnected) {
				this.embedActions.delete(id);
				continue;
			}
			if (actions.sourcePath === filePath) result.push(actions);
		}
		return result;
	}

	/**
	 * Scans a saved markdown file for handwriting embeds without transcripts,
	 * runs OCR silently on each, and inserts collapsed callout blocks.
	 * Called on every vault 'modify' event for .md files (debounced 3 s).
	 */
	private async handleAutoOcr(file: TFile): Promise<void> {
		if (!this.settings.autoOcrOnSave) return;
		if (!this.settings.geminiApiKey.trim()) return;
		if (this.processingFiles.has(file.path)) return;

		const content = await this.app.vault.read(file);
		const embedRegex = /!\[\[(_handwriting\/[^\]]+\.svg)\]\]/g;
		const toProcess: string[] = [];
		let m: RegExpExecArray | null;
		while ((m = embedRegex.exec(content)) !== null) {
			const svgPath = m[1]!;
			if (!findTranscript(content, svgPath)) toProcess.push(svgPath);
		}
		if (toProcess.length === 0) return;

		let updated = content;
		let count = 0;
		for (const svgPath of toProcess) {
			try {
				const svgFile = this.app.vault.getAbstractFileByPath(svgPath);
				if (!(svgFile instanceof TFile)) continue;
				const svgContent = await this.app.vault.read(svgFile);
				const ocrText = await runOcrRaw(svgContent, this);
				if (!ocrText) continue;
				updated = insertTranscript(updated, svgPath, ocrText);
				count++;
			} catch {
				// Skip this embed silently — don't block the rest
			}
		}

		if (count > 0) {
			this.processingFiles.add(file.path);
			try {
				await this.app.vault.modify(file, updated);
			} finally {
				this.processingFiles.delete(file.path);
			}
			new Notice(`Added ${count} transcript${count > 1 ? 's' : ''}`);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData() as Partial<HandwritingSettings>
		);
		// Migrazione: 'custom' non esiste più → 'auto'
		if ((this.settings.bgMode as string) === 'custom') {
			this.settings.bgMode = 'auto';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// Modal fuzzy-search per selezionare un SVG esistente nella cartella handwriting
// e inserire il riferimento ![[path]] nel cursore dell'editor attivo.
class SvgReferenceSuggest extends FuzzySuggestModal<TFile> {
	constructor(
		app: import('obsidian').App,
		private plugin: HandwritingPlugin,
		private editor: Editor
	) {
		super(app);
		this.setPlaceholder('Cerca SVG...');
	}

	// Restituisce tutti gli SVG nella cartella impostata (esclusa _converted)
	getItems(): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(this.plugin.settings.svgFolder);
		if (!(folder instanceof TFolder)) return [];
		return folder.children.filter(
			(f): f is TFile =>
				f instanceof TFile &&
				f.extension === 'svg' &&
				!f.path.includes('/_converted/')
		);
	}

	// Testo usato per il fuzzy-match (nome file)
	getItemText(file: TFile): string {
		return file.name;
	}

	// Mostra thumbnail SVG + nome file invece del solo testo
	renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
		const file = match.item;
		el.addClass('hwm_svg-suggest-item');
		// Thumbnail SVG tramite resource URL del vault
		const img = el.createEl('img', { cls: 'hwm_svg-thumb' });
		img.src = this.app.vault.getResourcePath(file);
		el.createEl('span', { text: file.name, cls: 'hwm_svg-suggest-name' });
	}

	// Inserisce ![[path]] al cursore quando l'utente seleziona un file
	onChooseItem(file: TFile): void {
		this.editor.replaceSelection(`![[${file.path}]]`);
	}
}
