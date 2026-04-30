import * as SecureStore from 'expo-secure-store';

const SESSION_PIN_KEY = 'zuna_vault_pin';

export async function getSessionPin(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SESSION_PIN_KEY, {
      keychainService: 'zuna_vault_session',
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      accessGroup: 'group.chat.zuna',
    });
  } catch {
    return null;
  }
}

export async function setSessionPin(pin: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_PIN_KEY, pin, {
    keychainService: 'zuna_vault_session',
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    accessGroup: 'group.chat.zuna',
  });
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SESSION_PIN_KEY, {
      keychainService: 'zuna_vault_session',
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      accessGroup: 'group.chat.zuna',
    });
  } catch {
    // ignore if not found
  }
}
