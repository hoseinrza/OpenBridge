import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { colors, fontAssets, fonts } from './src/theme';
import { AuthProvider, useAuth } from './src/context/AuthContext';
import LoginScreen from './src/screens/LoginScreen';
import ChatListScreen from './src/screens/ChatListScreen';
import ChatScreen from './src/screens/ChatScreen';
import VideoCallScreen from './src/screens/VideoCallScreen';

SplashScreen.preventAutoHideAsync();

const Stack = createNativeStackNavigator();

const navTheme = {
  dark: true,
  colors: {
    primary:      colors.accent,
    background:   colors.s0,
    card:         colors.s1,
    text:         colors.t1,
    border:       colors.border,
    notification: colors.accent,
  },
  fonts: {
    regular: { fontFamily: fonts.regular,  fontWeight: '400' },
    medium:  { fontFamily: fonts.medium,   fontWeight: '500' },
    bold:    { fontFamily: fonts.bold,     fontWeight: '700' },
    heavy:   { fontFamily: fonts.bold,     fontWeight: '800' },
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: colors.s1 },
  headerTintColor: colors.t1,
  headerTitleStyle: { fontFamily: fonts.semibold },
  contentStyle: { backgroundColor: colors.s0 },
};

function RootNavigator() {
  const { currentUser, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.s0, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Stack.Navigator screenOptions={screenOptions}>
      {!currentUser ? (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      ) : (
        <>
          <Stack.Screen name="ChatList" component={ChatListScreen} options={{ title: 'گفتگوها' }} />
          <Stack.Screen
            name="Chat"
            component={ChatScreen}
            options={({ route }) => ({ title: route.params?.peer?.name ?? 'گفتگو' })}
          />
          <Stack.Screen name="VideoCall" component={VideoCallScreen} options={{ title: 'تماس' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <AuthProvider>
      <NavigationContainer theme={navTheme}>
        <StatusBar style="light" />
        <RootNavigator />
      </NavigationContainer>
    </AuthProvider>
  );
}
