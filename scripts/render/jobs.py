"""Review renders queued on a Blender timer, so a long batch neither blocks the UI nor runs into the
time limit of a remote (MCP) call.  Progress is written to renders/review/_job_status.json after
every image; the rig controls touched by a batch are put back when the queue is done.

    import jobs
    jobs.run([({"throttle": 1.0}, ["ab_rear34", "ab_side"], "r26b_"),
              ({"throttle": 0.0}, ["nozzle_side"], "r26b_t0_")], frame=30)
"""
import json
import os
import time

import bpy

import review

STATUS = os.path.join(review.OUT, "_job_status.json")


def run(batches, frame=1, samples=48, res=(960, 540), out=review.OUT):
    """batches: [(rig props, views, file prefix), ...]; a view is a name in review.VIEWS or
    (name, (location, target, lens))."""
    rig = bpy.data.objects["F35I_Rig"]
    queue = [(props, v, pre) for props, views, pre in batches for v in views]
    keys = {k for props, _, _ in batches for k in props}
    saved = {k: rig[k] for k in keys if k in rig}
    st = {"start": time.strftime("%H:%M:%S"), "total": len(queue), "r": {}}

    def write():
        with open(STATUS, "w") as f:
            json.dump(st, f, indent=1)

    def tick():
        sc = bpy.context.scene
        if not queue:
            for k, v in saved.items():
                rig[k] = v
            sc.frame_set(sc.frame_current)
            st["end"] = time.strftime("%H:%M:%S")
            write()
            return None
        props, v, pre = queue.pop(0)
        for k, val in props.items():
            rig[k] = val
        sc.frame_set(frame)
        name = v if isinstance(v, str) else v[0]
        try:
            st["r"][pre + name] = review.shots([v], samples=samples, res=res, prefix=pre, out=out)[name]
        except Exception as e:                      # keep going; the error is in the status file
            st["r"][pre + name] = repr(e)
        write()
        return 0.1

    write()
    bpy.app.timers.register(tick, first_interval=0.5)
    return len(queue)
