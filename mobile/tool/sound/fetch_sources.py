"""Fetch the CC0 recordings build.py layers into the game's sounds (about 250 MB, not committed) into SRC:
  SRC=/some/dir python3 mobile/tool/sound/fetch_sources.py
archive.org: the USC Cinema / Sunset Editorial sound-effects libraries (CC0 1.0). Kenney Interface Sounds (CC0 1.0) comes
as SRC/kenney/*.wav, from github.com/Calinou/kenney-interface-sounds."""
import urllib.request,urllib.parse,os,time
SRC=os.environ.get('SRC','sound-src'); os.makedirs(SRC,exist_ok=True)
J='GOLD_TAPE_08_09_10_11_Aircraft-Jets';P='GOLD_TAPE_05_06_Aircraft-2_Engine_Props';R='Red_Library_Aircraft_Jets';M='Red_Library_Aircraft_Misc';A='GOLD_TAPE_16_17_18_Ambience'
W={'large_takeoff':(J,'G10-12-Large Jet Take Off.wav'),'const19':(J,'G08-19-Constant Overhead Jet Noise.wav'),'const20':(J,'G08-20-Constant Jet Noise.wav'),'const18':(J,'G09-18-Constant Jet Noise.wav'),'const10':(J,'G10-02-Constant Jet Noise.wav'),'whine':(J,'G10-04_F-105 Jet Constant Whine.wav'),'idle26':(J,'G08-26-Jet Idles.wav'),'taxi_tarmac':(J,'G09-08-Jet Taxi on Tarmac.wav'),'starts':(J,'G09-19-Jet Engine Starts and Stops.wav'),'land2':(J,'G09-12-Two Jets Land.wav'),'b52':(J,'G11-24_B-52 Jet Fly By.wav'),'b47_land':(J,'G08-30_B-47 Approach and Land.wav'),
'astrojet':(R,'R02-38-Astrojet Taxi.wav'),'startup':(R,'R02-42-Jet Start Up.wav'),'soar':(R,'R02-46-Large Jet Soaring Through Air.wav'),
'skid':(M,'R02-24-Airplane Tire Skid.wav'),'wait_to':(M,'R02-41-Airplane Waiting for Take Off.wav'),'taxi_in':(M,'R02-39-Airplane Taxi In.wav'),'onground':(M,'R02-32-Airplane on Ground.wav'),
'prop_idle':(P,'G06-18_C-47 2 Engine Prop Idle.wav'),'prop_steady':(P,'G06-13_2 Engine Prop Steady Engine.wav'),'prop_skid':(P,'G05-21_2 Engine Prop Lands With Skid.wav'),
'airport_out':(A,'G16-02-Outdoor Airport Ambience.wav'),'crickets':(A,'G16-07-Crickets Near and Far.wav'),'wind':('SSE_Library_WIND','GENERAL/WIND_Steady wind_CS_USC.wav'),'wind_dull':('Red_Library_Nature_Wind','R22-15-Noisy Dull Wind.wav')}
for k,(i,n) in W.items():
    f=os.path.join(SRC,f'{k}.wav')
    if os.path.exists(f): continue
    u=f'https://archive.org/download/{i}/'+urllib.parse.quote(n)
    for a in range(3):
        try:
            d=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'generic-client/1.0'}),timeout=120).read(); open(f,'wb').write(d); break
        except Exception as e: print('retry',k,e,flush=True); time.sleep(8)
    time.sleep(1)
print(len(os.listdir(SRC)),'of',len(W))
