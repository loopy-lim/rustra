import { registerRootComponent } from 'expo';

import BenchmarkApp from './BenchmarkApp';
import DynamicRegistryApp from './DynamicRegistryApp';

const App = process.env.EXPO_PUBLIC_RUSTRA_DEMO === 'dynamic' ? DynamicRegistryApp : BenchmarkApp;

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
