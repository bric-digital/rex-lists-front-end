/**
 * Service Worker module for webmunk-block-allow
 *
 * Handles automatic configuration sync from backend
 */

import { syncListsFromConfig } from '@bric/webmunk-core/list-utilities'

console.log('[webmunk-block-allow] Service worker module loaded')

/**
 * Configuration for list sync
 */
interface SyncConfig {
  configUrl?: string
  syncIntervalMinutes?: number
}

let syncConfig: SyncConfig = {
  syncIntervalMinutes: 60 // Default: sync every hour
}

/**
 * Initialize the block-allow module
 * Sets up automatic configuration sync
 */
export async function setup(config?: SyncConfig): Promise<void> {
  console.log('[webmunk-block-allow] Setting up service worker module')

  // Merge provided config with defaults
  if (config) {
    syncConfig = { ...syncConfig, ...config }
  }

  // Perform initial sync if config URL is provided
  if (syncConfig.configUrl) {
    console.log('[webmunk-block-allow] Performing initial configuration sync')
    await performSync()
  }

  // Set up periodic sync alarm
  if (syncConfig.syncIntervalMinutes && syncConfig.syncIntervalMinutes > 0) {
    console.log(`[webmunk-block-allow] Setting up periodic sync every ${syncConfig.syncIntervalMinutes} minutes`)

    chrome.alarms.create('webmunk-list-sync', {
      periodInMinutes: syncConfig.syncIntervalMinutes
    })

    // Listen for alarm
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === 'webmunk-list-sync') {
        console.log('[webmunk-block-allow] Periodic sync triggered')
        await performSync()
      }
    })
  }
}

/**
 * Perform configuration sync from backend
 */
async function performSync(): Promise<void> {
  if (!syncConfig.configUrl) {
    console.warn('[webmunk-block-allow] No config URL provided, skipping sync')
    return
  }

  try {
    const result = await syncListsFromConfig(syncConfig.configUrl)

    if (result.success) {
      console.log('[webmunk-block-allow] Sync completed successfully')
      console.log('[webmunk-block-allow] Lists updated:', result.listsUpdated)

      // Store last sync timestamp
      await chrome.storage.local.set({
        'webmunk_last_list_sync': Date.now()
      })
    } else {
      console.error('[webmunk-block-allow] Sync failed:', result.errors)
    }
  } catch (error) {
    console.error('[webmunk-block-allow] Sync error:', error)
  }
}

/**
 * Manually trigger a sync
 * Can be called from extension UI
 */
export async function triggerManualSync(): Promise<boolean> {
  console.log('[webmunk-block-allow] Manual sync triggered')

  try {
    await performSync()
    return true
  } catch (error) {
    console.error('[webmunk-block-allow] Manual sync failed:', error)
    return false
  }
}

/**
 * Get last sync timestamp
 */
export async function getLastSyncTime(): Promise<number | null> {
  const result = await chrome.storage.local.get('webmunk_last_list_sync')
  return result.webmunk_last_list_sync || null
}

// Default export for module system
export default {
  setup,
  triggerManualSync,
  getLastSyncTime
}
