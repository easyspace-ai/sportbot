import { describe, expect, it } from 'vitest';
import { resolveHttpPlatformProxyUrlForRuntime } from './effectiveBotSettings';

describe('resolveHttpPlatformProxyUrlForRuntime', () => {
  it('rewrites loopback proxy URLs to the Docker host gateway inside Docker', () => {
    const resolved = resolveHttpPlatformProxyUrlForRuntime('http://127.0.0.1:15236', {
      runningInDocker: true,
      dockerHost: 'host.docker.internal',
      allowContainerLoopback: false,
    });

    expect(resolved).toEqual({
      url: 'http://host.docker.internal:15236/',
      rewrittenForDockerHost: true,
    });
  });

  it('keeps loopback proxy URLs when container loopback is explicitly allowed', () => {
    const resolved = resolveHttpPlatformProxyUrlForRuntime('http://127.0.0.1:15236', {
      runningInDocker: true,
      dockerHost: 'host.docker.internal',
      allowContainerLoopback: true,
    });

    expect(resolved).toEqual({
      url: 'http://127.0.0.1:15236',
      rewrittenForDockerHost: false,
    });
  });

  it('does not rewrite non-loopback proxy URLs', () => {
    const resolved = resolveHttpPlatformProxyUrlForRuntime('http://proxy.internal:15236', {
      runningInDocker: true,
      dockerHost: 'host.docker.internal',
      allowContainerLoopback: false,
    });

    expect(resolved).toEqual({
      url: 'http://proxy.internal:15236',
      rewrittenForDockerHost: false,
    });
  });
});
