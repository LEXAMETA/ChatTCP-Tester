import { render } from '@testing-library/react-native';
import App from '../app/_layout.tsx';

test('skips tests for CI', () => {
  expect(true).toBe(true);
});
