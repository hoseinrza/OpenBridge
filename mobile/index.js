import { I18nManager } from 'react-native';
import { registerRootComponent } from 'expo';

import App from './App';

// OpenBridge is Persian-only — force RTL layout app-wide. On native this
// only fully applies after a reload, which is expected the first time the
// dev client/app is installed (shake menu → Reload, or relaunch the app).
if (!I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
