/**
 * ZAO - Toast
 *
 * Minimal, self-contained toast for brief confirmations ("Copied", etc).
 * No external toast library - this is intentionally tiny (fade in, hold,
 * fade out) so it doesn't add another native dependency for one line of
 * text. Mount <Toast ref={toastRef} /> once near the root of a screen and
 * call toastRef.current?.show('Copied') from anywhere on that screen.
 */

import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useTheme } from '../theme/useTheme';

const Toast = forwardRef(function Toast(_props, ref) {
  const theme = useTheme();
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef(null);

  useImperativeHandle(ref, () => ({
    show(text, durationMs = 1400) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setMessage(text);
      setVisible(true);
      opacity.setValue(0);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();

      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }).start(() => setVisible(false));
      }, durationMs);
    },
  }));

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        {
          opacity,
          backgroundColor: theme.mode === 'dark' ? '#F3F4F6' : '#1F2937',
        },
      ]}
    >
      <Text style={[styles.text, { color: theme.mode === 'dark' ? '#131313' : '#FFFFFF' }]}>
        {message}
      </Text>
    </Animated.View>
  );
});

export default Toast;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 110,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    zIndex: 1000,
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
  },
});
