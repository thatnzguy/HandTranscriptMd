/* =============================================
   Handwriting to Markdown — Plugin Entry Point

   Registers:
   - Code block processor "handwriting" (embed inline)
   - Command to insert a new handwriting block
   - Settings tab
   ============================================= */

import { Plugin, TFile, TFolder, Notice, FuzzySuggestModal, FuzzyMatch, Editor, debounce, TAbstractFile } from 'obsidian';
import { t, setLocale } from './i18n';
import { DEFAULT_SETTINGS, HandwritingSettings, HandwritingSettingTab } from './settings';
import { registerEmbed, insertHandwritingBlock, runOcrRaw, findTranscript, insertTranscript, updateTranscript } from './embed';
import { VIEW_TYPE_HANDWRITING, DrawingEditorView } from './editor-view';
import { parseSvgStrokes } from './svg-utils';

export default class HandwritingPlugin extends Plugin {
	settings: HandwritingSettings;

	// Map of callbacks to update inline previews when the editor tab saves
	public previewCallbacks = new Map<string, (svgContent: string) => void>();

	// Map embedId → svgPath: allows finding SVG files to remap on bgMode change
	public embedPaths = new Map<string, string>();

	// Callbacks notified when the user changes bgMode in settings
	public bgModeListeners = new Set<(bgMode: string) => void>();

	// Tracks files currently being modified by auto-OCR to prevent re-entrant processing
	private processingFiles = new Set<string>();

	// Map embedId → actions (expand/collapse/convert): used by the Obsidian "⋮" menu
	public embedActions = new Map<string, {
		expand:     () => void;
		collapse:   () => void;
		convert:    () => Promise<void>;
		setLoading: (loading: boolean) => void;
		container:  HTMLElement;
		sourcePath: string;
	}>();

	// Called by the editor tab after each save to update the inline preview
	refreshPreview(id: string, svgContent: string) {
		this.previewCallbacks.get(id)?.(svgContent);
	}

	// Called by settings when the user changes bgMode:
	// notifies panels (dark class update) and active SVGs (color remap)
	notifyBgModeChange() {
		this.bgModeListeners.forEach(cb => cb(this.settings.bgMode));
	}

	async onload() {
		await this.loadSettings();

		// Apply the saved interface language (or system language if 'auto')
		setLocale(this.settings.uiLanguage);

		// Detect Obsidian theme changes. Dual mechanism for maximum Android compatibility:
		// - css-change: Obsidian event guaranteed on theme change (more reliable on some Android WebViews)
		// - MutationObserver: fallback for body class changes from third-party plugins or older versions
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

		// Auto-OCR on SVG save: trigger OCR when a drawing file is written to disk
		this.registerEvent(
			this.app.vault.on('modify', debounce((file: TAbstractFile) => {
				if (file instanceof TFile &&
					file.extension === 'svg' &&
					file.parent?.path === this.settings.svgFolder) {
					void this.handleSvgSave(file);
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

		// Entries in the Obsidian "⋮" (three-dot) menu for bulk operations on all drawings.
		// Added with setSection('danger') and then moved before "Delete file"
		// via (menu as any).items — the only way to position them in the last section
		// above Delete without using more unstable private APIs.
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
						// Sequential: stops on first error
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
				// Move the 3 newly added items before the first existing 'danger' item
				// (i.e. before "Delete file"), so they appear above it.
				// Access to non-public internal Menu property: needed for repositioning.
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
	 * Called when an SVG drawing file is saved. Runs OCR and inserts or updates
	 * the transcript callout in every markdown note that embeds this SVG.
	 * Skips empty drawings (no strokes).
	 */
	private async handleSvgSave(svgFile: TFile): Promise<void> {
		if (!this.settings.autoOcrOnSave) return;
		if (!this.settings.geminiApiKey.trim()) return;
		if (this.processingFiles.has(svgFile.path)) return;

		this.processingFiles.add(svgFile.path);
		// Show a loading spinner on every embed that references this SVG
		const loadingActions = this.findEmbedActionsForSvg(svgFile.path);
		try {
			const svgContent = await this.app.vault.read(svgFile);

			// Skip empty drawings — no strokes means nothing to transcribe
			if (parseSvgStrokes(svgContent).length === 0) return;

			loadingActions.forEach(a => a.setLoading(true));

			const ocrText = await runOcrRaw(svgContent, this);
			if (!ocrText) return;

			// Find all markdown notes that embed this SVG via the metadata cache
			const mdFiles = this.findMarkdownFilesEmbedding(svgFile.path);
			let count = 0;
			for (const mdFile of mdFiles) {
				if (this.processingFiles.has(mdFile.path)) continue;
				this.processingFiles.add(mdFile.path);
				try {
					const content = (await this.app.vault.read(mdFile)).replace(/\r\n/g, '\n');
					const updated = findTranscript(content, svgFile.path)
						? updateTranscript(content, svgFile.path, ocrText)
						: insertTranscript(content, svgFile.path, ocrText);
					if (updated !== content) {
						await this.app.vault.modify(mdFile, updated);
						count++;
					}
				} finally {
					this.processingFiles.delete(mdFile.path);
				}
			}
			if (count > 0) new Notice(`Handwriting transcript updated`);
		} finally {
			loadingActions.forEach(a => a.setLoading(false));
			this.processingFiles.delete(svgFile.path);
		}
	}

	/** Returns the registered portal-panel actions for every embed of svgPath. */
	private findEmbedActionsForSvg(svgPath: string) {
		const result: Array<{ setLoading: (loading: boolean) => void }> = [];
		for (const [embedId, path] of this.embedPaths) {
			if (path === svgPath) {
				const actions = this.embedActions.get(embedId);
				if (actions) result.push(actions);
			}
		}
		return result;
	}

	/** Returns all markdown TFiles whose resolved links include svgPath. */
	private findMarkdownFilesEmbedding(svgPath: string): TFile[] {
		const result: TFile[] = [];
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const [notePath, links] of Object.entries(resolved)) {
			if (links[svgPath]) {
				const file = this.app.vault.getAbstractFileByPath(notePath);
				if (file instanceof TFile && file.extension === 'md') result.push(file);
			}
		}
		return result;
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

// Fuzzy-search modal for selecting an existing SVG in the handwriting folder
// and inserting the ![[path]] reference at the active editor cursor.
class SvgReferenceSuggest extends FuzzySuggestModal<TFile> {
	constructor(
		app: import('obsidian').App,
		private plugin: HandwritingPlugin,
		private editor: Editor
	) {
		super(app);
		this.setPlaceholder('Cerca SVG...');
	}

	// Returns all SVGs in the configured folder (excluding _converted)
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

	// Text used for fuzzy-match (file name)
	getItemText(file: TFile): string {
		return file.name;
	}

	// Shows SVG thumbnail + file name instead of plain text
	renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
		const file = match.item;
		el.addClass('hwm_svg-suggest-item');
		// SVG thumbnail via vault resource URL
		const img = el.createEl('img', { cls: 'hwm_svg-thumb' });
		img.src = this.app.vault.getResourcePath(file);
		el.createEl('span', { text: file.name, cls: 'hwm_svg-suggest-name' });
	}

	// Inserts ![[path]] at the cursor when the user selects a file
	onChooseItem(file: TFile): void {
		this.editor.replaceSelection(`![[${file.path}]]`);
	}
}
