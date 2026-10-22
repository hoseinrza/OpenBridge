import { useEffect, useMemo } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { fontAssets, fonts, navFonts, useAppTheme } from './src/theme';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { SocketProvider } from './src/context/SocketContext';
import LoginScreen from './src/screens/LoginScreen';
import ChatListScreen from './src/screens/ChatListScreen';
import ChatScreen from './src/screens/ChatScreen';
import ChatProfileScreen from './src/screens/ChatProfileScreen';
import ChatHeaderTitle from './src/components/ChatHeaderTitle';
import NewGroupScreen from './src/screens/NewGroupScreen';
import ContactsScreen from './src/screens/ContactsScreen';

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
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);
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

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <AuthProvider>
      <SocketProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style={dark ? 'light' : 'dark'} />
          <RootNavigator />
        </NavigationContainer>
      </SocketProvider>
    </AuthProvider>
  );
}
