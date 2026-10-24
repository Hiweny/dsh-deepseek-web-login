package com.hiweny.dshweb;

import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 请求闸门（移植自上游 src/gate.ts 的核心语义）：
 *  - allowConcurrent=false（默认）时**串行**，一次只放行一条，其余 FIFO 排队；
 *  - 两次调用之间在 [minIntervalMs, maxIntervalMs] 内**随机**等待（固定间隔本身就是机器特征）；
 *  - 间隔从「上一次调用**结束**」时刻起算，所以长回答之后不会额外白等。
 */
public final class Gate {

    private static final Semaphore SEM = new Semaphore(1, true);
    private static volatile long lastEndMs = 0;
    public static final AtomicInteger inflight = new AtomicInteger(0);
    public static final AtomicInteger queued = new AtomicInteger(0);
    public static volatile long lastWaitMs = 0;

    private Gate() {
    }

    public interface Release {
        void release();
    }

    public static Release acquire(String purpose) throws InterruptedException {
        if (!Cfg.allowConcurrent()) {
            queued.incrementAndGet();
            try {
                while (!SEM.tryAcquire(200, TimeUnit.MILLISECONDS)) {
                    // 等待期间保持可中断（HTTP 客户端断开时线程会被打断）
                }
            } finally {
                queued.decrementAndGet();
            }
        }
        // 间隔（从上次调用结束起算）
        int min = Cfg.minIntervalMs();
        int max = Cfg.maxIntervalMs();
        if (max > 0 && lastEndMs > 0) {
            long target = min + (long) (Math.random() * Math.max(0, max - min));
            long wait = lastEndMs + target - System.currentTimeMillis();
            if (wait > 0) {
                lastWaitMs = wait;
                Thread.sleep(Math.min(wait, 35000));
            } else {
                lastWaitMs = 0;
            }
        }
        inflight.incrementAndGet();
        final boolean serial = !Cfg.allowConcurrent();
        return () -> {
            lastEndMs = System.currentTimeMillis();
            inflight.decrementAndGet();
            if (serial) SEM.release();
        };
    }

    public static String stat() {
        return "串行=" + (!Cfg.allowConcurrent()) + " 在跑=" + inflight.get() + " 排队=" + queued.get()
                + " 间隔=" + Cfg.minIntervalMs() + "~" + Cfg.maxIntervalMs() + "ms";
    }
}
