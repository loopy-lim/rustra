import { useState } from 'react';
import { Button, SafeAreaView, Text } from 'react-native';
import { addNumbers } from './generated/react-native.js';

export default function App() {
  const [value, setValue] = useState<number>();
  return (
    <SafeAreaView>
      <Button
        title="20 + 22"
        onPress={() => void addNumbers({ a: 20, b: 22 }).then((result) => setValue(result.value))}
      />
      <Text>{value ?? 'Ready'}</Text>
    </SafeAreaView>
  );
}
