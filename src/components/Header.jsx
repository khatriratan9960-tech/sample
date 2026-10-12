/**
 * Brand header.
 *
 * Top of the page is the site's NAME banner (public/img/image.png,
 * "dpboosssss.com" with the crown logo) - shown whole (never cropped),
 * centered, capped in height so it does not push the results down.
 * Below it sits the original welcome bar:
 *   live-matka-laxmi.jpg  - 90x68  "Live Matka LAXMI_PICTURE"
 */
export default function Header() {
  return (
    <>
      {/* Site-name banner (dpboosssss.com) - the website's brand. */}
      <div
        style={{
          marginBottom: '2px',
          display: 'flex',
          justifyContent: 'center',
          overflow: 'hidden',
          borderRadius: '10px',
          border: '2px solid #ff182c',
          boxShadow: '0 0 20px 0 rgb(0 0 0 / 40%)',
        }}
      >
        <img
          src="/img/image.png"
          alt="dpboosssss.com - Satta Matka Fast Result"
          width="1024"
          height="559"
          style={{
            display: 'block',
            width: 'auto',
            maxWidth: '100%',
            maxHeight: '240px',
          }}
        />
      </div>
      <div
        style={{
          marginBottom: '1px',
          display: 'flex',
          padding: '5px',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderRadius: '10px',
          border: '2px solid #ff182c',
          boxShadow: '0 0 20px 0 rgb(0 0 0 / 40%)',
        }}
      >
        <img
          src="/img/live-matka-laxmi.jpg"
          alt="Live Matka LAXMI_PICTURE"
          width="90"
          height="68"
        />
        <p style={{ color: 'black', display: 'inline-block', fontSize: '16px' }}>
          !! Welcome to Live Matka international !! Satta Matka Fast Result
        </p>
      </div>
    </>
  );
}
