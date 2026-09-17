#include "core.hpp"
#include <chrono>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <cassert>
#include <stdexcept>
using namespace margelo::nitro::nitrobench;
static void require(bool value){if(!value)throw std::runtime_error("core correctness mismatch");}
ParityTree load(const std::string& path) {
 std::ifstream f(path);size_t count;f>>count;ParityTree tree;tree.nodes.reserve(count);
 for(size_t i=0;i<count;i++) {
  double id;std::string name,tag,note;int hasNote;size_t maps,children;
  f>>id>>std::quoted(name)>>std::quoted(tag)>>hasNote>>std::quoted(note)>>maps;
  std::unordered_map<std::string,std::string> metadata;
  for(size_t j=0;j<maps;j++){std::string k,v;f>>std::quoted(k)>>std::quoted(v);metadata.emplace(k,v);}
  f>>children;std::vector<double> links;links.reserve(children);
  for(size_t j=0;j<children;j++){double v;f>>v;links.push_back(v);}
  tree.nodes.emplace_back(id,name,tag,hasNote?std::optional<std::string>(note):std::nullopt,metadata,links);
 }
 require(bool(f));return tree;
}
int main(int argc,char**argv){
 const bool inspect=argc>1 && std::string(argv[1])=="--inspect";
 require(argc>(inspect?2:1));
 ParityNode node;auto base=reinterpret_cast<const char*>(&node);
 std::cout<<"{\"layout\":{\"nodeSize\":"<<sizeof(node)<<",\"nodeAlign\":"<<alignof(ParityNode)<<",\"id\":"<<(reinterpret_cast<const char*>(&node.id)-base)<<",\"name\":"<<(reinterpret_cast<const char*>(&node.name)-base)<<",\"tag\":"<<(reinterpret_cast<const char*>(&node.tag)-base)<<",\"note\":"<<(reinterpret_cast<const char*>(&node.note)-base)<<",\"metadata\":"<<(reinterpret_cast<const char*>(&node.metadata)-base)<<",\"children\":"<<(reinterpret_cast<const char*>(&node.children)-base)<<",\"searchSize\":"<<sizeof(ParitySearch)<<"}}\n";
 HybridNitroBench bench;
 for(int arg=inspect?2:1;arg<argc;arg++) {
  auto tree=load(argv[arg]);size_t count=tree.nodes.size();
  double id=count-1;bench.parityStore(tree);tree=ParityTree{};
  auto hit=bench.parityResident(ParityQuery(id));require(hit.found&&hit.id==id&&hit.name=="node-"+std::to_string(count-1)&&hit.visited==count);
  require(bench.parityResident(ParityQuery(-1)).visited==count);require(bench.parityResident(ParityQuery(0)).visited==1);require(bench.parityIndexed(ParityQuery(id)).visited==1);
  tree=load(argv[arg]);tree.nodes.back().name="updated";bench.parityStore(tree);tree=ParityTree{};
  require(bench.parityResident(ParityQuery(id)).name=="updated"&&bench.parityIndexed(ParityQuery(id)).name=="updated");
  tree=load(argv[arg]);
  const size_t inputNodeCapacity=tree.nodes.capacity();size_t inputChildCapacity=0;
  for(const auto& n:tree.nodes)inputChildCapacity+=n.children.capacity();
  bench.parityStore(tree);tree=ParityTree{};
  if(inspect){
   std::cout<<"{\"fixture\":"<<std::quoted(argv[arg])<<",\"nodes\":"<<count
     <<",\"mode\":\"inspect\",\"inputNodeCapacity\":"<<inputNodeCapacity
     <<",\"inputChildCapacitySum\":"<<inputChildCapacity<<",";
   bench.diagnosticInspect(std::cout,id);std::cout<<"}\n";continue;
  }
  std::vector<double> samples;double checksum=0;
  for(int round=-3;round<31;round++){
   auto start=std::chrono::steady_clock::now();
   for(int i=0;i<16;i++){auto r=bench.parityResident(ParityQuery(id));checksum+=r.id+r.visited+r.name.size()+(r.found?1:0);}
   double elapsed=std::chrono::duration<double,std::nano>(std::chrono::steady_clock::now()-start).count()/16;
   if(round>=0)samples.push_back(elapsed);
  }
  std::cout<<std::setprecision(17)<<"{\"fixture\":\""<<argv[arg]<<"\",\"nodes\":"<<count<<",\"inputNodeCapacity\":"<<inputNodeCapacity<<",\"inputChildCapacitySum\":"<<inputChildCapacity<<",\"batch\":16,\"warmup\":3,\"checksum\":"<<checksum<<",\"samplesNs\":[";
  for(size_t i=0;i<samples.size();i++){if(i)std::cout<<",";std::cout<<samples[i];}std::cout<<"]}\n";
 }
 bench.parityStore(ParityTree{});require(!bench.parityResident(ParityQuery(0)).found);
}
