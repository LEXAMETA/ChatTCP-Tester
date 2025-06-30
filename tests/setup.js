jest.mock('react-native-simple-toast', () => ({
  show: jest.fn(),
  showWithGravity: jest.fn(),
}));
