import {
  AxiosError,
  AxiosHeaders,
  CanceledError,
  InternalAxiosRequestConfig,
} from 'axios';
import { describe, expect, test, vitest } from 'vitest';
import { RetrySlot } from '../src/slots/retry-slot';
import sleep from 'sleep-promise';

test('允许重试', async () => {
  const retry = new RetrySlot();
  const config: InternalAxiosRequestConfig = {
    url: '/users',
    method: 'get',
    headers: new AxiosHeaders(),
    timestamp: Date.now(),
  };
  const error = new AxiosError('', void 0, config, null, undefined);

  await expect(retry.validate(error, config, 1)).resolves.toBeTruthy();
});

test('validate权限最高', async () => {
  const retry = new RetrySlot({
    validate(config) {
      return config.url !== '/users';
    },
  });
  const config1: InternalAxiosRequestConfig = {
    url: '/users',
    method: 'get',
    headers: new AxiosHeaders(),
    timestamp: Date.now(),
  };
  const error1 = new AxiosError('', void 0, config1, null, undefined);
  const config2: InternalAxiosRequestConfig = {
    url: '/admins',
    method: 'get',
    headers: new AxiosHeaders(),
    timestamp: Date.now(),
  };
  const error2 = new AxiosError('', void 0, config2, null, undefined);

  await expect(retry.validate(error1, config1, 1)).resolves.toBeFalsy();
  await expect(retry.validate(error2, config2, 1)).resolves.toBeTruthy();
});

test('最大重试次数', async () => {
  const retry = new RetrySlot({
    maxTimes: 2,
  });

  const config: InternalAxiosRequestConfig = {
    url: '/users',
    method: 'get',
    headers: new AxiosHeaders(),
    timestamp: Date.now(),
  };
  const error = new AxiosError('', void 0, config, null, undefined);

  await expect(retry.validate(error, config, 1)).resolves.toBeTruthy();
  await expect(retry.validate(error, config, 2)).resolves.toBeTruthy();
  await expect(retry.validate(error, config, 3)).resolves.toBeFalsy();
  await expect(retry.validate(error, config, 2)).resolves.toBeTruthy();
  await expect(retry.validate(error, config, 1)).resolves.toBeTruthy();
});

test('被手动取消的请求不会重试', async () => {
  const retry = new RetrySlot();
  const config: InternalAxiosRequestConfig = {
    url: '/users',
    method: 'get',
    headers: new AxiosHeaders(),
    timestamp: Date.now(),
  };

  await expect(retry.validate(new CanceledError(''), config, 1)).resolves.toBeFalsy();
});

test('匹配http状态码', async () => {
  const retry = new RetrySlot();
  const retry1 = new RetrySlot({
    allowedHttpStatus: [[400, 500], 600],
  });

  const config: InternalAxiosRequestConfig = {
    url: '/users',
    method: 'get',
    headers: new AxiosHeaders(),
    timestamp: Date.now(),
  };
  const error = new AxiosError(
    '',
    void 0,
    config,
    {},
    {
      status: 600,
      data: [],
      statusText: 'Bad Request',
      headers: {},
      config,
    },
  );

  await expect(retry.validate(error, config, 1)).resolves.toBeFalsy();
  await expect(retry1.validate(error, config, 1)).resolves.toBeTruthy();
});

describe('解决401授权问题', () => {
  const config: InternalAxiosRequestConfig = {
    url: '/users',
    method: 'post',
    headers: new AxiosHeaders(),
    timestamp: Date.now(),
  };
  const error = new AxiosError(
    '',
    void 0,
    config,
    {},
    {
      status: 401,
      data: [],
      statusText: 'Unauthorized',
      headers: {},
      config,
    },
  );

  test('返回true', async () => {
    const retry = new RetrySlot({
      allowedMethods: ['get'],
      allowedHttpStatus: [400],
      async resolveUnauthorized() {
        return true;
      },
      onAuthorized() {},
    });
    await expect(retry.validate(error, config, 1)).resolves.toBeTruthy();
  });

  test('返回false', async () => {
    const retry = new RetrySlot({
      allowedMethods: ['get'],
      allowedHttpStatus: [400],
      async resolveUnauthorized() {
        return false;
      },
      onAuthorized() {},
    });
    await expect(retry.validate(error, config, 1)).resolves.toBeFalsy();
  });

  test('报错', async () => {
    const retry = new RetrySlot({
      allowedMethods: ['get'],
      allowedHttpStatus: [400],
      async resolveUnauthorized() {
        throw new Error('x');
      },
      onAuthorized() {},
    });
    await expect(retry.validate(error, config, 1)).resolves.toBeFalsy();
  });

  test('多个请求出现未授权情况时，只处理一次授权', async () => {
    const spy1 = vitest.fn();
    const spy2 = vitest.fn();

    const retry = new RetrySlot({
      allowedMethods: ['get'],
      allowedHttpStatus: [400],
      async resolveUnauthorized() {
        await sleep(2000);
        spy1();
        return true;
      },
      onAuthorized() {
        spy2();
      },
    });

    const result = await Promise.all([
      retry.validate(error, config, 1),
      retry.validate(error, config, 1),
      retry.validate(error, config, 1),
      retry.validate(error, config, 1),
    ]);

    expect(spy1).toBeCalledTimes(1);
    expect(spy2).toBeCalledTimes(4);
    expect(result).toMatchObject([true, true, true, true]);
  });

  test('有请求在重新授权后才响应并返回401状态码，则应当共用授权数据', async () => {
    const spy1 = vitest.fn();
    const spy2 = vitest.fn();

    const retry = new RetrySlot({
      allowedMethods: ['get'],
      allowedHttpStatus: [400],
      async resolveUnauthorized() {
        await sleep(2000);
        spy1();
        return true;
      },
      onAuthorized() {
        spy2();
      },
    });

    const config1: InternalAxiosRequestConfig = {
      url: '/users',
      method: 'get',
      headers: new AxiosHeaders(),
      timestamp: Date.now(),
    };
    const config2: InternalAxiosRequestConfig = {
      url: '/users',
      method: 'get',
      headers: new AxiosHeaders(),
      timestamp: Date.now() - 10000,
    };
    const config3: InternalAxiosRequestConfig = {
      url: '/users',
      method: 'get',
      headers: new AxiosHeaders(),
      timestamp: Date.now() + 10000,
    };

    await retry.validate(error, config1, 1);
    expect(spy1).toBeCalledTimes(1);
    expect(spy2).toBeCalledTimes(1);

    await retry.validate(error, config2, 1);

    expect(spy1).toBeCalledTimes(1);
    expect(spy2).toBeCalledTimes(2);

    await retry.validate(error, config3, 1);
    expect(spy1).toBeCalledTimes(2);
    expect(spy2).toBeCalledTimes(3);
  });
});
