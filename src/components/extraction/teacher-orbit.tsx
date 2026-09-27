import Image from "next/image";
import { Clock, Settings } from "lucide-react";

const badge =
  "absolute flex size-[12.803px] items-center justify-center rounded-full " +
  "bg-[linear-gradient(121.62deg,#fb975d_30.947%,#fc5e24_69.775%)]";

// Teacher avatar with orbiting badges. Built at the desktop size (138px) and
// scaled to 0.8 for phones, which is how the phone design relates to it.
export function TeacherOrbit() {
  return (
    <div aria-hidden className="relative size-[110.424px] shrink-0 lg:size-[138.031px]">
      <div className="absolute top-0 left-0 size-[138.031px] origin-top-left scale-[0.8] lg:scale-100">
        <Image
          src="/assets/orbit/ring-outer.svg"
          alt=""
          width={138.031}
          height={138.031}
          className="absolute top-0 left-0 max-w-none"
        />
        <Image
          src="/assets/orbit/ring-inner.svg"
          alt=""
          width={108.024}
          height={108.024}
          className="absolute top-[15.6px] left-[15.0035px] max-w-none"
        />
        <Image
          src="/assets/orbit/ellipse-3.svg"
          alt=""
          width={78.6174}
          height={77.7801}
          className="absolute top-[30.33px] left-[30.21px] max-w-none"
        />
        <Image
          src="/assets/orbit/ellipse-4.svg"
          alt=""
          width={69.0153}
          height={83.0184}
          className="absolute top-[25.806px] left-[35.005px] max-w-none"
        />
        <Image
          src="/assets/images/teacher.png"
          alt=""
          width={78.617}
          height={96.821}
          className="absolute top-[11.4px] left-[30.21px] h-[96.821px] w-[78.617px] max-w-none rounded-[52.745px] object-cover"
        />

        <div className="absolute top-[13.303px] left-[12.003px] h-[111.425px] w-[113.025px]">
          <span className={`${badge} top-[32.41px] left-0`}>
            <Image src="/assets/orbit/task-square.svg" alt="" width={7.00125} height={7.00125} />
          </span>
          <span className={`${badge} top-[69.82px] left-[100.22px]`}>
            <Image src="/assets/orbit/cloud-lightning.svg" alt="" width={7.00125} height={7.00125} />
          </span>
          <span className={`${badge} top-0 left-[70.82px]`}>
            <Clock size={7.001} color="white" />
          </span>
          <span className={`${badge} top-[98.62px] left-[27.81px]`}>
            <Settings size={7.001} color="white" />
          </span>
        </div>
      </div>
    </div>
  );
}
