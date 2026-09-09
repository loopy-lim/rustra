import { registerRootComponent } from 'expo';

import BenchmarkApp from './BenchmarkApp';
import DynamicRegistryApp from './DynamicRegistryApp';
import HotCoreApp from './HotCoreApp';
import ReloadStressApp from './ReloadStressApp';

const demo = process.env.EXPO_PUBLIC_RUSTRA_DEMO;
const App =
  demo === 'dynamic'
    ? DynamicRegistryApp
    : demo === 'reload'
      ? ReloadStressApp
      : demo === 'hot-core'
        ? HotCoreApp
        : BenchmarkApp;

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
