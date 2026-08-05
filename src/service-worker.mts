/**
 * Service Worker module for rex-lists-front-end
 *
 * Handles automatic configuration sync from backend
 */

import { syncListsFromConfig, setDebug } from '@bric/rex-lists'
import rexCorePlugin from '@bric/rex-core/service-worker'
import { type REXConfiguration } from '@bric/rex-core/common'

console.log('[rex-lists-front-end] Service worker module loaded')

/**
 * Configuration for list sync
 */
interface SyncConfig {
  configUrl?: string
  syncIntervalMinutes?: number
}

interface ListsFrontEndConfig {
  enabled?: boolean
  config_url?: string
  sync_interval_minutes?: number
}

const LOCAL_OVERRIDE_KEY = 'webmunkListsFrontEndConfiguration'
const DEFAULT_SYNC_INTERVAL_MINUTES = 60

let syncConfig: SyncConfig = {
  syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES
}
let storageListenerRegistered = false
let isSyncInProgress = false

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>
  }
  return undefined
}

function readListsFrontEndConfig(value: unknown): ListsFrontEndConfig | undefined {
  const candidate = asRecord(value)
  if (!candidate) return undefined

  const nested = asRecord(candidate.lists_front_end)
  if (nested) {
    return nested as ListsFrontEndConfig
  }

  return candidate as ListsFrontEndConfig
}

async function resolveConfigUrl(
  baseConfiguration: REXConfiguration | undefined,
  serverConfig: ListsFrontEndConfig | undefined,
  overrideConfig: ListsFrontEndConfig | undefined,
  setupConfig: SyncConfig | undefined
): Promise<string | undefined> {
  const base = asRecord(baseConfiguration as unknown)
  const pdk = asRecord(base?.passive_data_kit)

  let configUrl =
    setupConfig?.configUrl ??
    overrideConfig?.config_url ??
    serverConfig?.config_url ??
    (typeof pdk?.configuration === 'string' ? pdk.configuration : undefined) ??
    (typeof base?.configuration_url === 'string' ? base.configuration_url : undefined)

  if (typeof configUrl !== 'string' || configUrl.length === 0) {
    return undefined
  }

  if (configUrl.includes('<IDENTIFIER>')) {
    const identifierResult = await chrome.storage.local.get('rexIdentifier')
    const identifier = (identifierResult.rexIdentifier as string | undefined)?.toString().trim()
    if (!identifier) return undefined
    configUrl = configUrl.replaceAll('<IDENTIFIER>', identifier)
  }

  return configUrl
}

async function loadEffectiveSyncConfig(setupConfig?: SyncConfig): Promise<SyncConfig> {
  let baseConfiguration: REXConfiguration | undefined
  try {
    baseConfiguration = await rexCorePlugin.fetchConfiguration()
  } catch (error) {
    console.warn('[rex-lists-front-end] Could not fetch configuration from rex-core:', error)
  }

  const base = asRecord(baseConfiguration as unknown)
  const serverConfig = readListsFrontEndConfig(base?.lists_front_end)

  const localResult = await chrome.storage.local.get(LOCAL_OVERRIDE_KEY)
  const overrideConfig = readListsFrontEndConfig(localResult[LOCAL_OVERRIDE_KEY])

  const syncIntervalMinutes =
    setupConfig?.syncIntervalMinutes ??
    overrideConfig?.sync_interval_minutes ??
    serverConfig?.sync_interval_minutes ??
    DEFAULT_SYNC_INTERVAL_MINUTES

  // Apply debug setting from lists_config section
  const listsModuleConfig = asRecord(base?.lists_config)
  setDebug(listsModuleConfig?.debug === true)

  const configUrl = await resolveConfigUrl(baseConfiguration, serverConfig, overrideConfig, setupConfig)

  const effectiveConfig: SyncConfig = {
    syncIntervalMinutes
  }

  if (configUrl !== undefined) {
    effectiveConfig.configUrl = configUrl
  }

  return effectiveConfig
}

async function configureSyncAlarm(): Promise<void> {
  await chrome.alarms.clear('webmunk-list-sync')

  if (syncConfig.syncIntervalMinutes && syncConfig.syncIntervalMinutes > 0) {
    console.log(`[rex-lists-front-end] Setting up periodic sync every ${syncConfig.syncIntervalMinutes} minutes`)
    await chrome.alarms.create('webmunk-list-sync', {
      periodInMinutes: syncConfig.syncIntervalMinutes
    })
  }
}

function registerStorageListener(): void {
  if (storageListenerRegistered) return

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    if (!changes.REXConfiguration && !changes.rexIdentifier && !changes[LOCAL_OVERRIDE_KEY]) return

    loadEffectiveSyncConfig()
      .then(async (updatedConfig) => {
        const previousConfigUrl = syncConfig.configUrl
        const previousInterval = syncConfig.syncIntervalMinutes
        syncConfig = updatedConfig

        if (previousInterval !== syncConfig.syncIntervalMinutes) {
          await configureSyncAlarm()
        }

        if (previousConfigUrl !== syncConfig.configUrl) {
          await performSync()
        }
      })
      .catch((error) => {
        console.error('[rex-lists-front-end] Failed to reload sync configuration:', error)
      })
  })

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'webmunk-list-sync') {
      console.log('[rex-lists-front-end] Periodic sync triggered')
      await performSync()
    }
  })

  storageListenerRegistered = true
}

/**
 * Initialize the block-allow module
 * Sets up automatic configuration sync
 */
export async function setup(config?: SyncConfig): Promise<void> {
  console.log('[rex-lists-front-end] Setting up service worker module')

  syncConfig = await loadEffectiveSyncConfig(config)
  registerStorageListener()

  if (syncConfig.configUrl) {
    console.log('[rex-lists-front-end] Performing initial configuration sync')
    await performSync()
  }

  await configureSyncAlarm()
}

/**
 * Perform configuration sync from backend
 */
async function performSync(): Promise<void> {
  if (isSyncInProgress) {
    console.log('[rex-lists-front-end] Sync already in progress, skipping')
    return
  }

  if (!syncConfig.configUrl) {
    console.warn('[rex-lists-front-end] No config URL provided, skipping sync')
    return
  }

  try {
    isSyncInProgress = true
    const result = await syncListsFromConfig(syncConfig.configUrl)

    if (result.success) {
      console.log('[rex-lists-front-end] Sync completed successfully')
      console.log('[rex-lists-front-end] Lists updated:', result.listsUpdated)

      // Store last sync timestamp
      await chrome.storage.local.set({
        'webmunk_last_list_sync': Date.now()
      })
    } else {
      console.error('[rex-lists-front-end] Sync failed:', result.errors)
    }
  } catch (error) {
    console.error('[rex-lists-front-end] Sync error:', error)
  } finally {
    isSyncInProgress = false
  }
}

/**
 * Manually trigger a sync
 * Can be called from extension UI
 */
export async function triggerManualSync(): Promise<boolean> {
  console.log('[rex-lists-front-end] Manual sync triggered')

  try {
    await performSync()
    return true
  } catch (error) {
    console.error('[rex-lists-front-end] Manual sync failed:', error)
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

/**
 * Set local override configuration for this module.
 * This is merged over rex-core configuration at runtime.
 */
export async function setLocalOverrideConfiguration(override: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set({
    [LOCAL_OVERRIDE_KEY]: override
  })
}

/**
 * Clear local override configuration for this module.
 */
export async function clearLocalOverrideConfiguration(): Promise<void> {
  await chrome.storage.local.remove(LOCAL_OVERRIDE_KEY)
}

// Default export for module system
export default {
  setup,
  triggerManualSync,
  getLastSyncTime,
  setLocalOverrideConfiguration,
  clearLocalOverrideConfiguration
}
