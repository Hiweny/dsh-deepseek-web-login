package com.hiweny.dshweb;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;

/** 保活：JobScheduler 周期唤醒（15 分钟）检查服务是否还活着，掉了就拉起来。 */
public class KeepJobService extends JobService {

    public static final int JOB_ID = 7301;

    @Override
    public boolean onStartJob(JobParameters params) {
        try {
            if (!EngineService.running && Cfg.autoStart()) {
                App.Lg.i("JobScheduler 拉起服务");
                EngineService.start(this);
            }
            Engine.resumeTimers();
        } catch (Exception e) {
            App.Lg.w("job: " + e);
        }
        jobFinished(params, false);
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }

    public static void schedule(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            JobInfo.Builder b = new JobInfo.Builder(JOB_ID, new ComponentName(c, KeepJobService.class))
                    .setPersisted(true)
                    .setRequiresDeviceIdle(false)
                    .setRequiresCharging(false);
            if (Build.VERSION.SDK_INT >= 24) {
                b.setPeriodic(15 * 60 * 1000L, 5 * 60 * 1000L);
                b.setPrefetch(true);
            } else {
                b.setPeriodic(15 * 60 * 1000L);
            }
            js.schedule(b.build());
            App.Lg.i("保活任务已排期");
        } catch (Exception e) {
            App.Lg.w("排期失败: " + e);
        }
    }

    public static void cancel(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) js.cancel(JOB_ID);
        } catch (Exception ignored) {
        }
    }

    /** 电池优化白名单状态。 */
    public static boolean ignoringBattery(Context c) {
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
        } catch (Exception e) {
            return false;
        }
    }
}
