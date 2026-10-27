import { useEffect, useMemo } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { fontAssets, fonts, navFonts, useAppTheme } from './src/theme';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { SettingsProvider, useSettings } from './src/context/SettingsContext';
import { SocketProvider } from './src/context/SocketContext';
import { CallProvider } from './src/context/CallContext';
import CallOverlay from './src/components/CallOverlay';
import LoginScreen from './src/screens/LoginScreen';
import ChatListScreen from './src/screens/ChatListScreen';
import ChatScreen from './src/screens/ChatScreen';
import ChatProfileScreen from './src/screens/ChatProfileScreen';
import ChatHeaderTitle from './src/components/ChatHeaderTitle';
import NewGroupScreen from './src/screens/NewGroupScreen';
import ContactsScreen from './src/screens/ContactsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import EditProfileScreen from './src/screens/EditProfileScreen';

SplashScreen.preventAutoHideAsync();

const Stack = createNativeStackNavigator();

function RootNavigator() {
  const { currentUser, loading } = useAuth();
  const { colors } = useAppTheme();

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text1,
        headerTitleStyle: { fontFamily: fonts.semibold, fontSize: 16 },
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      {!currentUser ? (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      ) : (
        <>
          <Stack.Screen name="ChatList" component={ChatListScreen} options={{ title: 'گفتگوها' }} />
          <Stack.Screen
            name="Chat"
            component={ChatScreen}
            options={({ route, navigation }) => ({
              headerTitle: () => (
                <ChatHeaderTitle
                  peer={route.params?.peer}
                  onPress={() => navigation.navigate('ChatProfile', { peer: route.params?.peer })}
                />
              ),
            })}
          />
          <Stack.Screen
            name="ChatProfile"
            component={ChatProfileScreen}
            options={{ title: 'اطلاعات گفتگو' }}
          />
          <Stack.Screen name="NewGroup" component={NewGroupScreen} options={{ title: 'گروه جدید' }} />
          <Stack.Screen name="Contacts" component={ContactsScreen} options={{ title: 'مخاطبین' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'تنظیمات' }} />
          <Stack.Screen name="EditProfile" component={EditProfileScreen} options={{ title: 'ویرایش پروفایل' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

function AppShell() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  const { ready: settingsReady } = useSettings();
  const { dark, colors } = useAppTheme();

  const navTheme = useMemo(() => ({
    dark,
    colors: {
      primary: colors.accent,
      background: colors.bg,
      card: colors.surface,
      text: colors.text1,
      border: colors.border,
      notification: colors.accent,
    },
    fonts: navFonts,
  }), [dark, colors]);

  // The fonts are not enough: the stored theme arrives one tick later, and
  // hiding the splash before that paints the wrong colours until it hydrates.
  const booted = (fontsLoaded || !!fontError) && settingsReady;

  useEffect(() => {
    if (booted) SplashScreen.hideAsync();
  }, [booted]);

  if (!booted) return null;

  return (
    <AuthProvider>
      <SocketProvider>
        <CallProvider>
          <NavigationContainer theme={navTheme}>
            <StatusBar style={dark ? 'light' : 'dark'} />
            <RootNavigator />
          </NavigationContainer>
          <CallOverlay />
        </CallProvider>
      </SocketProvider>
    </AuthProvider>
  );
}

export default function App() {
  // `useSafeAreaInsets` throws when nothing above it renders a provider, and the
  // login screen and the always-mounted call overlay both read the insets — so
  // without this wrapper the app died on its first frame, before any screen
  // could paint. Jest hides it by mocking this module with a hook that never
  // throws; the emulator does not.
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <AppShell />
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
