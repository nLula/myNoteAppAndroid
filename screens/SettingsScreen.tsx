import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';
import SyncScreen from './settings/SyncScreen';
import LockScreen from './settings/LockScreen';
import TrashScreen from './settings/TrashScreen';
import SpaceScreen from './settings/SpaceScreen';
import { useThemeCtx } from '../themeContext';

const Tab = createBottomTabNavigator();

const ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  Sync: 'refresh-cw',
  Lock: 'lock',
  Trash: 'trash-2',
  Space: 'hard-drive',
};

export default function SettingsScreen() {
  const { theme: t } = useThemeCtx();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: { backgroundColor: t.bgSurface, borderTopColor: t.border },
        tabBarIcon: ({ color, size }) => <Feather name={ICONS[route.name]} size={size} color={color} />,
      })}
    >
      <Tab.Screen name="Sync" component={SyncScreen} />
      <Tab.Screen name="Lock" component={LockScreen} />
      <Tab.Screen name="Trash" component={TrashScreen} />
      <Tab.Screen name="Space" component={SpaceScreen} />
    </Tab.Navigator>
  );
}
