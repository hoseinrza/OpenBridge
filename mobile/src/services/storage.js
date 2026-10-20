import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// Same key names as the web app (localStorage) for conceptual parity —
// these are two separate storage backends, not shared state.
const USER_KEY    = 'chatapp_user';
const TOKEN_KEY   = 'chatapp_token';
const REFRESH_KEY = 'chatapp_refresh';

export const storage = {
  async getUser() {
    const raw = await AsyncStorage.getItem(USER_KEY);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  },
  async setUser(user) {
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  async removeUser() {
    await AsyncStorage.removeItem(USER_KEY);
  },

  // Token is a credential → SecureStore (Keychain/Keystore-backed), not AsyncStorage.
  async getToken() {
    return (await SecureStore.getItemAsync(TOKEN_KEY)) ?? '';
  },
  async setToken(token) {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  },
  async removeToken() {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  },
  async getRefreshToken() {
    return (await SecureStore.getItemAsync(REFRESH_KEY)) ?? '';
  },
  async setRefreshToken(token) {
    await SecureStore.setItemAsync(REFRESH_KEY, token);
  },
  async removeRefreshToken() {
    await SecureStore.deleteItemAsync(REFRESH_KEY);
  },
};
