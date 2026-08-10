/**
 * Extension UI module for rex-lists-front-end
 *
 * Provides UI for viewing and managing domain lists
 */

import $ from 'jquery'
import {
  getAllLists,
  getListEntries,
  createListEntry,
  updateListEntry,
  deleteListEntry,
  exportList,
  importList,
  type ListEntry,
  type PatternType,
  type EntrySource
} from '@bric/rex-lists'
import { REXExtensionModule } from '@bric/rex-core/extension'
import { type REXUIDefinition } from '@bric/rex-core/common'
import { triggerManualSync, getLastSyncTime } from './service-worker.mjs'

console.log('[rex-lists-front-end] Extension module loaded')

/**
 * REXExtensionModule for list editor UI
 */
export class ListsFrontEndExtensionModule extends REXExtensionModule {
  private currentList: string | null = null
  private currentEntries: ListEntry[] = []
  private allowBackendEntryDeletion = false

  /**
   * Setup the extension module
   */
  setup(): void {
    console.log('[rex-lists-front-end] Setting up extension module')
  }

  /**
   * Return the HTML for the list editor interface
   */
  fetchHtmlInterface(identifier: string): string | null {
    if (identifier !== 'list-editor') {
      return null
    }

    return '<div class="col-12" id="list-editor-container">' +
      '<div class="mb-3">' +
        '<button class="btn btn-outline-secondary" id="back-to-main">' +
          '<i class="bi bi-arrow-left me-2"></i>Back to Main' +
        '</button>' +
      '</div>' +
      '<div class="list-editor">' +
        '<div class="d-flex align-items-center justify-content-between mb-3">' +
          '<h4 class="mb-0">Domain List Manager</h4>' +
          '<div class="d-flex align-items-center">' +
            '<span id="last-sync-time" class="text-muted me-2">Last sync: Never</span>' +
            '<button id="sync-now-btn" class="btn btn-primary btn-sm">Sync Now</button>' +
          '</div>' +
        '</div>' +
        '<div class="row mb-3">' +
          '<div class="col-md-6">' +
            '<label for="list-selector" class="form-label">Select List:</label>' +
            '<select id="list-selector" class="form-select">' +
              '<option value="">-- Select a list --</option>' +
            '</select>' +
          '</div>' +
          '<div class="col-md-6 d-flex align-items-end justify-content-end gap-2">' +
            '<button id="add-entry-btn" class="btn btn-success" disabled>Add Entry</button>' +
            '<button id="export-list-btn" class="btn btn-secondary" disabled>Export</button>' +
            '<button id="import-list-btn" class="btn btn-secondary" disabled>Import</button>' +
          '</div>' +
        '</div>' +
        '<div id="list-table-container">' +
          '<p class="text-muted">Select a list to view its entries</p>' +
        '</div>' +
      '</div>' +
      '<div class="modal fade" id="entry-modal" tabindex="-1">' +
        '<div class="modal-dialog">' +
          '<div class="modal-content">' +
            '<div class="modal-header">' +
              '<h5 class="modal-title" id="entry-modal-title">Add Entry</h5>' +
              '<button type="button" class="btn-close" data-bs-dismiss="modal"></button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<form id="entry-form">' +
                '<input type="hidden" id="entry-id" />' +
                '<div class="mb-3">' +
                  '<label for="entry-domain" class="form-label">Domain/Pattern</label>' +
                  '<input type="text" class="form-control" id="entry-domain" required />' +
                  '<small class="form-text text-muted">e.g., google.com, *.example.com</small>' +
                '</div>' +
                '<div class="mb-3">' +
                  '<label for="entry-pattern-type" class="form-label">Pattern Type</label>' +
                  '<select class="form-select" id="entry-pattern-type" required>' +
                    '<option value="domain">Registered Domain ONLY (must be eTLD+1 like google.com)</option>' +
                    '<option value="host">Hostname (exact host; ignores leading www.)</option>' +
                    '<option value="exact_url">Exact URL</option>' +
                    '<option value="host_path_prefix">Host + Path Prefix (example.com/path...)</option>' +
                    '<option value="regex">Regular Expression</option>' +
                  '</select>' +
                '</div>' +
                '<div class="mb-3">' +
                  '<label for="entry-category" class="form-label">Category (optional)</label>' +
                  '<input type="text" class="form-control" id="entry-category" />' +
                '</div>' +
                '<div class="mb-3">' +
                  '<label for="entry-description" class="form-label">Description (optional)</label>' +
                  '<textarea class="form-control" id="entry-description" rows="2"></textarea>' +
                '</div>' +
              '</form>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>' +
              '<button type="button" class="btn btn-primary" id="save-entry-btn">Save</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<input type="file" id="import-file-input" accept=".json" style="display: none;" />' +
    '</div>'
  }

  /**
   * Activate the list editor interface
   */
  activateInterface(uiDefinition: REXUIDefinition): boolean {
    console.log('[rex-lists-front-end] Activating interface:', uiDefinition)

    if (uiDefinition.identifier !== 'list-editor') {
      return false
    }

    this.initializeAsync().catch((error) => {
      console.error('[rex-lists-front-end] Failed to initialize:', error)
    })

    return true
  }

  /**
   * Async initialization
   */
  private async initializeAsync(): Promise<void> {
    await this.waitForElement('#list-editor-container')
    await this.loadConfigurationFlags()
    // Attach handlers before the selector options load: a list selection made
    // in the gap between options appearing and handlers binding was lost.
    this.setupEventListeners()
    await this.loadListSelector()
    await this.updateSyncStatus()
  }

  /**
   * Read the module's configuration section for UI behavior flags.
   *
   * allow_delete_backend_entries: when true, entries provided by the study
   * configuration (source 'backend') get a Delete button like user entries.
   * Deletions persist until the study's lists configuration next changes —
   * a config update re-syncs backend entries and restores them. Default false:
   * study-configured entries are read-only for participants.
   */
  private async loadConfigurationFlags(): Promise<void> {
    try {
      const configuration = await chrome.runtime.sendMessage({ messageType: 'fetchConfiguration' }) as Record<string, unknown> | undefined
      const section = configuration?.['lists_front_end'] as Record<string, unknown> | undefined

      this.allowBackendEntryDeletion = section?.['allow_delete_backend_entries'] === true
    } catch (error) {
      console.warn('[rex-lists-front-end] Unable to read configuration flags:', error)
      this.allowBackendEntryDeletion = false
    }
  }

  /**
   * Wait for a DOM element to exist
   */
  private async waitForElement(selector: string): Promise<Element> {
    return new Promise((resolve) => {
      if (document.querySelector(selector)) {
        resolve(document.querySelector(selector)!)
        return
      }

      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) {
          observer.disconnect()
          resolve(document.querySelector(selector)!)
        }
      })

      observer.observe(document.body, {
        childList: true,
        subtree: true
      })
    })
  }

  /**
   * Load available lists into selector
   */
  private async loadListSelector(): Promise<void> {
    try {
      const lists = await getAllLists()

      const selector = $('#list-selector')
      selector.find('option:not(:first)').remove() // Clear existing options except first

      lists.forEach((listName: string) => {
        selector.append(`<option value="${listName}">${listName}</option>`)
      })

      console.log(`[rex-lists-front-end] Loaded ${lists.length} lists`)
    } catch (error) {
      console.error('[rex-lists-front-end] Failed to load lists:', error)
    }
  }

  /**
   * Load and display entries for selected list
   */
  private async loadListEntries(listName: string): Promise<void> {
    try {
      this.currentList = listName
      this.currentEntries = await getListEntries(listName)

      const container = $('#list-table-container')

      if (this.currentEntries.length === 0) {
        container.html('<p class="text-muted">No entries in this list</p>')
        return
      }

      // Create table
      let tableHtml = `
        <table class="table table-striped table-hover">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Pattern Type</th>
              <th>Category</th>
              <th>Source</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
      `

      this.currentEntries.forEach(entry => {
        const isBackend = entry.source === 'backend'
        const sourceBadge = this.getSourceBadge(entry.source)

        let actionsHtml = `
            <button class="btn btn-sm btn-primary edit-entry-btn" data-id="${entry.id}">Edit</button>
            <button class="btn btn-sm btn-danger delete-entry-btn" data-id="${entry.id}">Delete</button>
          `

        if (isBackend) {
          // Study-configured entries are read-only unless the configuration
          // opts in to participant deletion (allow_delete_backend_entries).
          actionsHtml = this.allowBackendEntryDeletion
            ? `<button class="btn btn-sm btn-danger delete-entry-btn" data-id="${entry.id}">Delete</button>`
            : '<span class="text-muted">Read-only</span>'
        }

        tableHtml += `
          <tr>
            <td>${this.escapeHtml(entry.pattern)}</td>
            <td>${entry.pattern_type}</td>
            <td>${this.escapeHtml(entry.metadata.category || '-')}</td>
            <td>${sourceBadge}</td>
            <td>${actionsHtml}</td>
          </tr>
        `
      })

      tableHtml += `
          </tbody>
        </table>
      `

      container.html(tableHtml)

      // Attach event listeners to edit/delete buttons
      $('.edit-entry-btn').on('click', (e) => {
        const id = $(e.currentTarget).data('id')
        this.showEditEntryModal(id)
      })

      $('.delete-entry-btn').on('click', (e) => {
        const id = $(e.currentTarget).data('id')
        this.deleteEntry(id)
      })

      console.log(`[rex-lists-front-end] Loaded ${this.currentEntries.length} entries for list: ${listName}`)
    } catch (error) {
      console.error('[rex-lists-front-end] Failed to load list entries:', error)
    }
  }

  /**
   * Get a badge HTML for entry source
   */
  private getSourceBadge(source: EntrySource): string {
    switch (source) {
      case 'backend':
        return '<span class="badge bg-primary">Configuration</span>'
      case 'user':
        return '<span class="badge bg-success">User</span>'
      case 'generated':
        return '<span class="badge bg-info">Generated</span>'
      default:
        return '<span class="badge bg-secondary">Unknown</span>'
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * Update sync status display
   */
  private async updateSyncStatus(): Promise<void> {
    try {
      const lastSync = await getLastSyncTime()

      if (lastSync) {
        const date = new Date(lastSync)
        $('#last-sync-time').text(`Last sync: ${date.toLocaleString()}`)
      } else {
        $('#last-sync-time').text('Last sync: Never')
      }
    } catch (error) {
      console.error('[rex-lists-front-end] Failed to get sync status:', error)
    }
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Accessibility: ensure focus isn't left inside the modal when it hides (Bootstrap sets aria-hidden).
    // We do this both on the Bootstrap lifecycle events and *before* the dismiss click handler runs.
    const modalEl = document.getElementById('entry-modal')
    const restoreFocusOutsideModal = () => {
      if (!modalEl) return

      const active = document.activeElement
      if (active instanceof HTMLElement && modalEl.contains(active)) {
        active.blur()
      }

      const addBtn = document.getElementById('add-entry-btn')
      if (addBtn instanceof HTMLElement) {
        addBtn.focus()
      }
    }

    if (modalEl) {
      // Before hide starts
      modalEl.addEventListener('hide.bs.modal', restoreFocusOutsideModal)
      // After hide completes (belt-and-suspenders)
      modalEl.addEventListener('hidden.bs.modal', restoreFocusOutsideModal)

      // Run *before* Bootstrap's dismiss click handler (capture phase).
      modalEl.querySelectorAll<HTMLElement>('[data-bs-dismiss="modal"]').forEach((el) => {
        el.addEventListener('click', restoreFocusOutsideModal, { capture: true })
      })
    }

    // List selector change
    $('#list-selector').on('change', async (e) => {
      const listName = $(e.currentTarget).val() as string

      if (listName) {
        await this.loadListEntries(listName)
        $('#add-entry-btn, #export-list-btn, #import-list-btn').prop('disabled', false)
      } else {
        $('#list-table-container').html('<p class="text-muted">Select a list to view its entries</p>')
        $('#add-entry-btn, #export-list-btn, #import-list-btn').prop('disabled', true)
      }
    })

    // Sync now button
    $('#sync-now-btn').on('click', async () => {
      $('#sync-now-btn').prop('disabled', true).text('Syncing...')

      const success = await triggerManualSync()

      if (success) {
        await this.updateSyncStatus()
        await this.loadListSelector()

        if (this.currentList) {
          await this.loadListEntries(this.currentList)
        }
      }

      $('#sync-now-btn').prop('disabled', false).text('Sync Now')
    })

    // Add entry button
    $('#add-entry-btn').on('click', () => {
      this.showAddEntryModal()
    })

    // Save entry button
    $('#save-entry-btn').on('click', async () => {
      await this.saveEntry()
    })

    // Export button
    $('#export-list-btn').on('click', async () => {
      await this.exportCurrentList()
    })

    // Import button
    $('#import-list-btn').on('click', () => {
      $('#import-file-input').trigger('click')
    })

    // Import file input
    $('#import-file-input').on('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        await this.importFromFile(file)
      }
    })
  }

  /**
   * Show modal for adding new entry
   */
  private showAddEntryModal(): void {
    $('#entry-modal-title').text('Add Entry')
    $('#entry-id').val('')
    $('#entry-domain').val('')
    $('#entry-pattern-type').val('domain')
    $('#entry-category').val('')
    $('#entry-description').val('')

    // Show modal (assuming Bootstrap is available)
    const modal = new (window as any).bootstrap.Modal(document.getElementById('entry-modal')!) // eslint-disable-line @typescript-eslint/no-explicit-any
    modal.show()
  }

  /**
   * Show modal for editing existing entry
   */
  private showEditEntryModal(entryId: number): void {
    const entry = this.currentEntries.find(e => e.id === entryId)

    if (!entry) {
      console.error('[rex-lists-front-end] Entry not found:', entryId)
      return
    }

    $('#entry-modal-title').text('Edit Entry')
    $('#entry-id').val(entry.id?.toString() || '')
    $('#entry-domain').val(entry.pattern)
    $('#entry-pattern-type').val(entry.pattern_type)
    $('#entry-category').val(entry.metadata.category || '')
    $('#entry-description').val(entry.metadata.description || '')

    const modal = new (window as any).bootstrap.Modal(document.getElementById('entry-modal')!) // eslint-disable-line @typescript-eslint/no-explicit-any
    modal.show()
  }

  /**
   * Save entry (create or update)
   */
  private async saveEntry(): Promise<void> {
    const entryId = $('#entry-id').val() as string
    const pattern = $('#entry-domain').val() as string
    const patternType = $('#entry-pattern-type').val() as PatternType
    const category = $('#entry-category').val() as string
    const description = $('#entry-description').val() as string

    if (!pattern || !this.currentList) {
      return
    }

    try {
      if (entryId) {
        // Update existing entry
        const metadata: Record<string, string> = {}
        if (category) metadata.category = category
        if (description) metadata.description = description

        await updateListEntry(parseInt(entryId), {
          pattern,
          pattern_type: patternType,
          metadata
        })
      } else {
        // Create new entry
        const metadata: Record<string, string> = {}
        if (category) metadata.category = category
        if (description) metadata.description = description

        await createListEntry({
          list_name: this.currentList,
          pattern,
          pattern_type: patternType,
          source: 'user',
          metadata
        })
      }

      // Reload list
      await this.loadListEntries(this.currentList)

      // Close modal. Blur first: hiding while a descendant (the Save button)
      // holds focus makes Chrome reject Bootstrap's aria-hidden for
      // accessibility ("Blocked aria-hidden on an element...").
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }

      const modal = (window as any).bootstrap.Modal.getInstance(document.getElementById('entry-modal')!) // eslint-disable-line @typescript-eslint/no-explicit-any
      modal?.hide()
    } catch (error) {
      console.error('[rex-lists-front-end] Failed to save entry:', error)

      // Validation errors carry the actionable message (wrong pattern type,
      // invalid domain, ...); showing it beats sending people to the console.
      const detail = error instanceof Error ? error.message : String(error)
      alert(`Failed to save entry: ${detail}`)
    }
  }

  /**
   * Delete an entry
   */
  private async deleteEntry(entryId: number): Promise<void> {
    if (!confirm('Are you sure you want to delete this entry?')) {
      return
    }

    try {
      await deleteListEntry(entryId)

      if (this.currentList) {
        await this.loadListEntries(this.currentList)
      }
    } catch (error) {
      console.error('[rex-lists-front-end] Failed to delete entry:', error)
      alert('Failed to delete entry. See console for details.')
    }
  }

  /**
   * Export current list to JSON file
   */
  private async exportCurrentList(): Promise<void> {
    if (!this.currentList) {
      return
    }

    try {
      const jsonData = await exportList(this.currentList)

      // Create download link
      const blob = new Blob([jsonData], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${this.currentList}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('[rex-lists-front-end] Failed to export list:', error)
      alert('Failed to export list. See console for details.')
    }
  }

  /**
   * Import list from JSON file
   */
  private async importFromFile(file: File): Promise<void> {
    if (!this.currentList) {
      return
    }

    try {
      const jsonData = await file.text()
      const count = await importList(this.currentList, jsonData)

      alert(`Successfully imported ${count} entries`)

      // Reload list
      await this.loadListEntries(this.currentList)
    } catch (error) {
      console.error('[rex-lists-front-end] Failed to import list:', error)
      alert('Failed to import list. See console for details.')
    }
  }
}

// Export module for use in extension
export default new ListsFrontEndExtensionModule()
