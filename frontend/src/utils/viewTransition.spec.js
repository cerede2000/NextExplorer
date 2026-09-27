import { describe, it, expect, vi, afterEach } from 'vitest';
import { withViewTransition } from './index';

/**
 * `document.startViewTransition` hands back promises. `ready` is rejected
 * whenever the transition does not get to animate — which on a plain
 * navigation is every time — and nothing here was listening, so each one
 * reached the console as `Uncaught (in promise) InvalidStateError: Transition
 * was aborted because of invalid state`, reading like a fault in an
 * application that had just navigated perfectly well.
 */

const aborted = () => {
  const error = new DOMException(
    'Transition was aborted because of invalid state',
    'InvalidStateError'
  );
  return Promise.reject(error);
};

const original = document.startViewTransition;

afterEach(() => {
  if (original) {
    document.startViewTransition = original;
  } else {
    delete document.startViewTransition;
  }
});

describe('running a navigation through a view transition', () => {
  it('navigates where the browser has no view transitions', () => {
    delete document.startViewTransition;
    const navigate = vi.fn();

    withViewTransition(navigate)('Documents');

    expect(navigate).toHaveBeenCalledWith('Documents');
  });

  it('navigates through the transition where it does', () => {
    const navigate = vi.fn();
    document.startViewTransition = vi.fn((callback) => {
      callback();
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: Promise.resolve(),
      };
    });

    withViewTransition(navigate)('Documents');

    expect(navigate).toHaveBeenCalledWith('Documents');
  });

  // The test that fails without the fix: an unobserved rejected promise is
  // reported by the runner, exactly as the browser reports it in the console.
  it('does not leave the abort unobserved', async () => {
    const navigate = vi.fn();
    document.startViewTransition = vi.fn((callback) => {
      callback();
      return {
        ready: aborted(),
        updateCallbackDone: Promise.resolve(),
        finished: Promise.resolve(),
      };
    });

    withViewTransition(navigate)('Photos');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigate).toHaveBeenCalledWith('Photos');
  });

  // `finished` is where a real error in the navigation itself would surface,
  // so it is deliberately left for someone to see.
  it('leaves the promise that carries a real failure alone', async () => {
    const navigate = vi.fn();
    const finished = Promise.reject(new Error('the navigation itself failed'));
    const seen = vi.fn();
    finished.catch(seen);

    document.startViewTransition = vi.fn((callback) => {
      callback();
      return { ready: aborted(), updateCallbackDone: Promise.resolve(), finished };
    });

    withViewTransition(navigate)('Projects');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toHaveBeenCalled();
  });
});
